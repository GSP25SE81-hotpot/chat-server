import express from "express";
import { createServer } from "http";
import cors from "cors";
import compression from "compression";
import { initSocketServer } from "./config/socket.js";
import dotenv from "dotenv";
import winston from "winston";
import cluster from "cluster";
import os from "os";

// Load environment variables
dotenv.config();

// Performance-optimized clustering
const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING === "true";
const MAX_WORKERS =
  parseInt(process.env.MAX_WORKERS || "0") || Math.max(1, os.cpus().length - 1);
const WORKER_COUNT = ENABLE_CLUSTERING ? MAX_WORKERS : 1;

// Master process for clustering
if (ENABLE_CLUSTERING && cluster.isMaster) {
  console.log(`Master ${process.pid} starting ${WORKER_COUNT} workers`);

  // Fork workers
  for (let i = 0; i < WORKER_COUNT; i++) {
    cluster.fork();
  }

  // Restart workers if they die
  cluster.on("exit", (worker, code, signal) => {
    console.log(
      `Worker ${worker.process.pid} died (${signal || code}). Restarting...`
    );
    cluster.fork();
  });
} else {
  // Worker process or single process mode
  startServer();
}

function startServer() {
  // Optimized logger with minimal overhead
  const logger = winston.createLogger({
    level: process.env.NODE_ENV === "production" ? "error" : "info",
    format: winston.format.json(),
    transports: [
      new winston.transports.Console({
        format: winston.format.simple(),
      }),
      new winston.transports.File({
        filename: "error.log",
        level: "error",
        maxsize: 5242880, // 5MB
        maxFiles: 2,
      }),
    ],
    // Reduce logging in production
    silent:
      process.env.NODE_ENV === "production" &&
      process.env.LOG_SILENT === "true",
  });

  // Initialize Express app with performance settings
  const app = express();

  // Performance middleware
  app.use(
    compression({
      level: 6, // Balance between CPU and compression ratio
      threshold: 0, // Compress all responses
    })
  );

  // Optimized CORS
  app.use(
    cors({
      origin: [
        "http://localhost:5000",
        "https://hpty.vinhuser.one",
        "https://localhost:7163",
        "https://hotpot-web-app-production.up.railway.app",
      ],
      methods: ["GET", "POST"],
      credentials: true,
      maxAge: 86400, // Cache preflight requests for 24 hours
    })
  );

  // Efficient JSON parsing
  app.use(
    express.json({
      limit: "1mb",
      strict: true,
    })
  );

  // Disable X-Powered-By header
  app.disable("x-powered-by");

  // Basic route for health check (minimal processing)
  app.get("/health", (req, res) => {
    const stats = socketServer
      ? socketServer.getStats()
      : { status: "initializing" };
    res.json({
      status: "ok",
      connections: stats.connectedClients || 0,
      uptime: stats.uptime || process.uptime(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    });
  });

  // Create HTTP server with optimized settings
  const server = createServer(app);

  // Set TCP keep-alive
  server.keepAliveTimeout = 65000; // Slightly higher than ALB idle timeout (60s)
  server.headersTimeout = 66000; // Slightly higher than keepAliveTimeout

  // Initialize Socket.IO server
  let socketServer;
  initSocketServer(server)
    .then((result) => {
      socketServer = result;
      logger.info("Socket.IO server initialized");
    })
    .catch((err) => {
      logger.error(`Socket.IO init error: ${err.message}`);
    });

  // Efficient health check endpoint
  app.get("/health", (req, res) => {
    const stats = socketServer
      ? socketServer.getStats()
      : { status: "initializing" };
    res.json({
      status: "ok",
      connections: stats.connectedClients || 0,
      uptime: stats.uptime || process.uptime(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    });
  });

  // Minimal error handler
  app.use((err, req, res, next) => {
    logger.error(`Error: ${err.message}`);
    res.status(500).send("Error");
  });

  // Start server
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT} (${process.pid})`);
  });

  // Efficient graceful shutdown
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  function gracefulShutdown() {
    logger.info(`Worker ${process.pid} shutting down`);

    // Set a timeout to force exit
    const forceExit = setTimeout(() => {
      process.exit(1);
    }, 10000);

    // Clear the timeout if we exit normally
    forceExit.unref();

    // Close server
    server.close(() => {
      if (socketServer && socketServer.io) {
        socketServer.io.close(() => {
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  }
}
