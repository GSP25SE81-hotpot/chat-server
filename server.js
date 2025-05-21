// server.js
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

// Determine if we should use clustering (disabled by default in low memory environments)
const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING === "true";
const MAX_WORKERS = process.env.MAX_WORKERS
  ? parseInt(process.env.MAX_WORKERS)
  : 2;
const WORKER_COUNT = ENABLE_CLUSTERING
  ? Math.min(MAX_WORKERS, os.cpus().length)
  : 1;

// Memory monitoring
const MEMORY_LIMIT = 450 * 1024 * 1024; // 450MB threshold
let isUnderMemoryPressure = false;

// If using cluster and this is the master process
if (ENABLE_CLUSTERING && cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < WORKER_COUNT; i++) {
    cluster.fork();
  }

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
  // Simplified logger to reduce memory usage
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console(),
      // Only log errors to file to reduce disk I/O
      new winston.transports.File({
        filename: "error.log",
        level: "error",
        maxsize: 5242880, // 5MB
        maxFiles: 2,
      }),
    ],
  });

  // Initialize Express app
  const app = express();

  // Essential middleware only
  app.use(compression());

  // Simplified CORS
  app.use(
    cors({
      origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
        : ["http://localhost:5000", "https://hpty.vinhuser.one"],
      methods: ["GET", "POST"],
      credentials: true,
    })
  );

  // Minimal JSON parsing with strict limits
  app.use(express.json({ limit: "100kb" }));

  // Basic route for health check
  app.get("/", (req, res) => {
    res.send("Socket.IO server is running");
  });

  // Memory status check
  app.get("/memory", (req, res) => {
    const memoryUsage = process.memoryUsage();
    const usage = {
      rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`,
      percentUsed: `${Math.round(
        (memoryUsage.rss / (512 * 1024 * 1024)) * 100
      )}%`,
      underPressure: isUnderMemoryPressure,
    };

    res.json(usage);

    // Attempt garbage collection if available
    if (global.gc && memoryUsage.rss > MEMORY_LIMIT * 0.8) {
      global.gc();
      logger.info("Manual garbage collection triggered");
    }
  });

  // Create HTTP server
  const server = createServer(app);

  // Initialize Socket.IO server
  let socketServer;
  initSocketServer(server)
    .then((result) => {
      socketServer = result;
      logger.info(
        `Socket.IO server initialized successfully (Worker: ${process.pid})`
      );
    })
    .catch((err) => {
      logger.error(`Failed to initialize Socket.IO server: ${err.message}`);
    });

  // Simplified health check endpoint
  app.get("/health", (req, res) => {
    const memoryUsage = process.memoryUsage();
    const health = {
      uptime: process.uptime(),
      pid: process.pid,
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      },
      connections: socketServer ? socketServer.getStats().connectedClients : 0,
      status: isUnderMemoryPressure ? "degraded" : "ok",
    };

    res.json(health);
  });

  // Minimal error handler
  app.use((err, req, res, next) => {
    logger.error(`Error: ${err.message}`);
    res.status(500).send("Server error");
  });

  // Start server
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    logger.info(
      `Socket.IO server running at http://localhost:${PORT}/ (Worker: ${process.pid})`
    );
  });

  // Memory monitoring
  const memoryCheckInterval = setInterval(() => {
    const memoryUsage = process.memoryUsage();

    // Check if we're approaching memory limits
    if (memoryUsage.rss > MEMORY_LIMIT) {
      if (!isUnderMemoryPressure) {
        isUnderMemoryPressure = true;
        logger.warn(
          `Memory pressure detected: ${Math.round(
            memoryUsage.rss / 1024 / 1024
          )}MB / 512MB`
        );

        // Notify Socket.IO to reduce memory usage
        if (socketServer && socketServer.io) {
          socketServer.io.emit("server:degraded", { reason: "memory" });
        }

        // Attempt garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }
    } else if (isUnderMemoryPressure && memoryUsage.rss < MEMORY_LIMIT * 0.8) {
      // Memory pressure has been relieved
      isUnderMemoryPressure = false;
      logger.info(
        `Memory pressure relieved: ${Math.round(
          memoryUsage.rss / 1024 / 1024
        )}MB / 512MB`
      );

      // Notify Socket.IO that server is back to normal
      if (socketServer && socketServer.io) {
        socketServer.io.emit("server:normal");
      }
    }
  }, 30000); // Check every 30 seconds

  // Graceful shutdown
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  function gracefulShutdown() {
    logger.info(`Worker ${process.pid} received shutdown signal`);

    // Clear intervals
    clearInterval(memoryCheckInterval);

    // Close HTTP server
    server.close(() => {
      logger.info(`HTTP server closed (Worker: ${process.pid})`);

      // Close Socket.IO connections if available
      if (socketServer && socketServer.io) {
        socketServer.io.close(() => {
          logger.info(`Socket.IO server closed (Worker: ${process.pid})`);
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });

    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
      logger.error(`Forced shutdown after timeout (Worker: ${process.pid})`);
      process.exit(1);
    }, 5000);
  }
}
