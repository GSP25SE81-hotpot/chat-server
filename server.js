// server.js
import express from "express";
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { initSocketServer } from "./config/socket.js";
import dotenv from "dotenv";
import winston from "winston";
import expressWinston from "express-winston";
import rateLimit from "express-rate-limit";

// Load environment variables
dotenv.config();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

// Initialize Express app
const app = express();

// Security headers
app.use(helmet());

// Compression
app.use(compression());

// Request logging
app.use(
  expressWinston.logger({
    winstonInstance: logger,
    meta: true,
    msg: "HTTP {{req.method}} {{req.url}}",
    expressFormat: true,
    colorize: false,
  })
);

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes",
});

// Apply rate limiting to all requests
app.use(apiLimiter);

// Configure CORS for the Express app
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : ["http://localhost:5000", "https://hpty.vinhuser.one"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// JSON body parser with size limits
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Basic route for health check
app.get("/", (req, res) => {
  res.send("Socket.IO server is running");
});

// Create HTTP server
const server = createServer(app);

// Initialize Socket.IO server
let socketServer;
initSocketServer(server)
  .then((result) => {
    socketServer = result;
    logger.info("Socket.IO server initialized successfully");
  })
  .catch((err) => {
    logger.error(`Failed to initialize Socket.IO server: ${err.message}`);
  });

// Socket.IO stats endpoint
app.get("/stats", (req, res) => {
  if (!socketServer) {
    return res.status(503).json({ error: "Socket.IO server not initialized" });
  }

  const stats = socketServer.getStats();
  res.json(stats);
});

// Detailed health check endpoint
app.get("/health", (req, res) => {
  const health = {
    uptime: process.uptime(),
    message: "OK",
    timestamp: Date.now(),
    socketServer: socketServer ? "initialized" : "not initialized",
    connectedClients: socketServer
      ? socketServer.getStats().connectedClients
      : 0,
    memory: process.memoryUsage(),
  };

  res.json(health);
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { error: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Socket.IO server running at http://localhost:${PORT}/`);
});

// Graceful shutdown
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

function gracefulShutdown() {
  logger.info("Received shutdown signal, closing server...");

  // Close HTTP server
  server.close(() => {
    logger.info("HTTP server closed");

    // Close Socket.IO connections if available
    if (socketServer && socketServer.io) {
      socketServer.io.close(() => {
        logger.info("Socket.IO server closed");
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });

  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}
