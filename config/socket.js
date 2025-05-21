// config/socket.js
import { Server } from "socket.io";
import { instrument } from "@socket.io/admin-ui";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import winston from "winston";

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: "socket-error.log",
      level: "error",
    }),
    new winston.transports.File({ filename: "socket-combined.log" }),
  ],
});

// Track connected clients and their statistics
const connectedClients = new Map();
let totalConnections = 0;
let totalMessages = 0;
let totalErrors = 0;

// Rate limiting configuration
const rateLimits = {
  connection: { points: 10, duration: 60 }, // 10 connections per minute
  message: { points: 60, duration: 60 }, // 60 messages per minute
};

// Rate limiter implementation
class RateLimiter {
  constructor(points, duration) {
    this.points = points;
    this.duration = duration;
    this.clients = new Map();
  }

  consume(clientId) {
    const now = Date.now();
    let clientData = this.clients.get(clientId);

    if (!clientData) {
      clientData = { points: this.points, lastRefill: now };
      this.clients.set(clientId, clientData);
      return true;
    }

    // Refill points based on time elapsed
    const timePassed = now - clientData.lastRefill;
    const pointsToAdd =
      Math.floor(timePassed / 1000) * (this.points / this.duration);

    if (pointsToAdd > 0) {
      clientData.points = Math.min(
        this.points,
        clientData.points + pointsToAdd
      );
      clientData.lastRefill = now;
    }

    if (clientData.points >= 1) {
      clientData.points -= 1;
      return true;
    }

    return false;
  }
}

const connectionLimiter = new RateLimiter(
  rateLimits.connection.points,
  rateLimits.connection.duration
);

const messageLimiter = new RateLimiter(
  rateLimits.message.points,
  rateLimits.message.duration
);

// JWT verification function
const verifyToken = (token) => {
  try {
    if (!token) return null;
    const secret = process.env.JWT_SECRET || "your-fallback-secret-key";
    return jwt.verify(token, secret);
  } catch (error) {
    logger.error(`JWT verification error: ${error.message}`);
    return null;
  }
};

// Socket middleware for authentication
const authMiddleware = (socket, next) => {
  try {
    // Get token from handshake auth or query
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    // For backward compatibility, allow non-authenticated connections
    // but mark them as unauthenticated
    if (!token) {
      socket.auth = false;
      socket.userId = null;
      socket.userRole = null;
      return next();
    }

    const decoded = verifyToken(token);
    if (decoded) {
      socket.auth = true;
      socket.userId = decoded.userId;
      socket.userRole = decoded.role;
      logger.info(
        `User ${decoded.userId} authenticated via JWT as ${decoded.role}`
      );
    } else {
      socket.auth = false;
      socket.userId = null;
      socket.userRole = null;
    }

    next();
  } catch (error) {
    logger.error(`Auth middleware error: ${error.message}`);
    next(new Error("Authentication error"));
  }
};

// Socket middleware for rate limiting
const rateLimitMiddleware = (socket, next) => {
  const clientId = socket.handshake.address;

  if (!connectionLimiter.consume(clientId)) {
    logger.warn(`Rate limit exceeded for connection from ${clientId}`);
    return next(new Error("Connection rate limit exceeded"));
  }

  next();
};

export async function initSocketServer(server) {
  // Redis adapter setup (optional, for scalability)
  let redisClient;
  let redisAdapter;

  if (process.env.REDIS_URL) {
    try {
      redisClient = createClient({ url: process.env.REDIS_URL });
      const subClient = redisClient.duplicate();

      await redisClient.connect();
      await subClient.connect();

      redisAdapter = createAdapter(redisClient, subClient);
      logger.info("Redis adapter initialized for Socket.IO");
    } catch (error) {
      logger.error(`Redis connection failed: ${error.message}`);
      logger.info("Falling back to in-memory adapter");
    }
  }

  // Socket.IO server configuration
  const io = new Server(server, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
        : ["http://localhost:5000", "https://hpty.vinhuser.one"],
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60000, // 60 seconds ping timeout
    pingInterval: 25000, // 25 seconds ping interval
    connectTimeout: 30000, // 30 seconds connection timeout
    maxHttpBufferSize: 1e6, // 1MB max payload size
    transports: ["websocket", "polling"],
    allowUpgrades: true,
    perMessageDeflate: {
      threshold: 1024, // Compress data if size > 1KB
    },
    httpCompression: {
      threshold: 1024,
    },
    serveClient: false, // Don't serve client files
  });

  // Set up admin UI if enabled
  if (process.env.SOCKET_ADMIN_UI === "true") {
    instrument(io, {
      auth: {
        type: "basic",
        username: process.env.SOCKET_ADMIN_USER || "admin",
        password: process.env.SOCKET_ADMIN_PASS || "admin",
      },
    });
    logger.info("Socket.IO Admin UI enabled");
  }

  // Use Redis adapter if available
  if (redisAdapter) {
    io.adapter(redisAdapter);
  }

  // Apply middlewares
  io.use(rateLimitMiddleware);
  io.use(authMiddleware);

  // Error handling for the server
  io.engine.on("connection_error", (err) => {
    totalErrors++;
    logger.error(`Connection error: ${err.code} ${err.message} ${err.context}`);
  });

  // Connection handling
  io.on("connection", (socket) => {
    totalConnections++;
    const clientId = socket.id;
    const clientIp = socket.handshake.address;
    const userAgent = socket.handshake.headers["user-agent"];

    // Store client info
    connectedClients.set(clientId, {
      id: clientId,
      ip: clientIp,
      userAgent,
      userId: socket.userId,
      userRole: socket.userRole,
      authenticated: socket.auth,
      connectedAt: new Date(),
      messageCount: 0,
      errorCount: 0,
    });

    logger.info(`Client connected: ${clientId} from ${clientIp}`, {
      socketId: clientId,
      userAgent,
      authenticated: socket.auth,
      userId: socket.userId,
      userRole: socket.userRole,
    });

    // Legacy authentication method (for backward compatibility)
    socket.on("authenticate", (data) => {
      try {
        logger.info("Authentication request:", data);

        // Store user info on socket
        socket.userId = data.userId;
        socket.userRole = data.role;
        socket.auth = true;

        // Update client info
        const clientInfo = connectedClients.get(clientId);
        if (clientInfo) {
          clientInfo.userId = data.userId;
          clientInfo.userRole = data.role;
          clientInfo.authenticated = true;
        }

        logger.info(`User ${data.userId} authenticated as ${data.role}`);

        // Acknowledge successful authentication
        socket.emit("authenticated", { success: true });
      } catch (error) {
        logger.error(`Authentication error: ${error.message}`);
        socket.emit("authenticated", {
          success: false,
          error: "Authentication failed",
        });
      }
    });

    // Event handler helper with rate limiting and error handling
    const createEventHandler = (eventName, handler) => {
      socket.on(eventName, async (...args) => {
        try {
          // Apply rate limiting for message events
          if (!messageLimiter.consume(clientIp)) {
            logger.warn(
              `Rate limit exceeded for ${eventName} from ${clientIp}`
            );
            socket.emit("error", { message: "Rate limit exceeded" });
            return;
          }

          // Track message count
          totalMessages++;
          const clientInfo = connectedClients.get(clientId);
          if (clientInfo) {
            clientInfo.messageCount++;
          }

          // Log the event
          logger.debug(`[EVENT] ${eventName}:`, args);

          // Execute the handler
          await handler(...args);
        } catch (error) {
          totalErrors++;

          // Track error count
          const clientInfo = connectedClients.get(clientId);
          if (clientInfo) {
            clientInfo.errorCount++;
          }

          logger.error(`Error handling ${eventName}: ${error.message}`, {
            socketId: clientId,
            userId: socket.userId,
            error: error.stack,
          });

          // Notify client of error
          socket.emit("error", {
            message: "Error processing request",
            event: eventName,
            requestId: uuidv4(),
          });
        }
      });
    };

    // Chat events with enhanced error handling and logging
    createEventHandler("newChatRequest", async (data) => {
      logger.info("New chat request:", data);

      // Validate data
      if (!data || !data.sessionId || !data.customerId) {
        throw new Error("Invalid chat request data");
      }

      // Add request ID for tracking
      const requestId = uuidv4();
      data.requestId = requestId;

      // Broadcast to all except sender
      socket.broadcast.emit("newChatRequest", data);

      // Acknowledge receipt
      socket.emit("newChatRequestAck", {
        success: true,
        requestId,
        sessionId: data.sessionId,
      });
    });

    createEventHandler("acceptChat", async (data) => {
      logger.info("Chat accepted:", data);

      // Validate data
      if (!data || !data.sessionId || !data.managerId || !data.customerId) {
        throw new Error("Invalid chat accept data");
      }

      // Add timestamp
      data.acceptedAt = new Date().toISOString();

      // Emit to all clients
      io.emit("chatAccepted", data);
    });

    createEventHandler("sendMessage", async (data) => {
      logger.info("Message sent:", {
        messageId: data.messageId,
        senderId: data.senderId,
        receiverId: data.receiverId,
      });

      // Validate data
      if (!data || !data.messageId || !data.senderId || !data.receiverId) {
        throw new Error("Invalid message data");
      }

      // Add server timestamp
      data.serverTimestamp = new Date().toISOString();

      // Emit to all clients
      io.emit("receiveMessage", data);
    });

    createEventHandler("markMessageRead", async (data) => {
      logger.info("Message marked as read:", data);

      // Validate data
      if (!data || !data.messageId) {
        throw new Error("Invalid message read data");
      }

      // Emit to all clients
      io.emit("messageRead", data.messageId);
    });

    createEventHandler("endChat", async (data) => {
      logger.info("Chat ended:", data);

      // Validate data
      if (!data || !data.sessionId) {
        throw new Error("Invalid end chat data");
      }

      // Add timestamp
      data.endedAt = new Date().toISOString();

      // Emit to all clients
      io.emit("chatEnded", data.sessionId);
    });

    // Handle disconnection
    socket.on("disconnect", (reason) => {
      const clientInfo = connectedClients.get(clientId);
      const duration = clientInfo
        ? (new Date() - clientInfo.connectedAt) / 1000
        : 0;

      logger.info(
        `Client disconnected: ${clientId}, Reason: ${reason}, Duration: ${duration}s`,
        {
          socketId: clientId,
          userId: socket.userId,
          reason,
          duration,
          messageCount: clientInfo?.messageCount,
        }
      );

      // Remove from connected clients
      connectedClients.delete(clientId);
    });

    // Handle errors
    socket.on("error", (error) => {
      totalErrors++;
      logger.error(`Socket error for ${clientId}: ${error.message}`);
    });

    // Catch all events for logging
    socket.onAny((event, ...args) => {
      if (event !== "ping" && event !== "pong") {
        logger.debug(`[EVENT] ${event}:`, args);
      }
    });
  });

  // Health check endpoint
  return {
    io,
    getStats: () => ({
      connectedClients: connectedClients.size,
      totalConnections,
      totalMessages,
      totalErrors,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      clients: Array.from(connectedClients.values()).map((c) => ({
        id: c.id,
        userId: c.userId,
        userRole: c.userRole,
        authenticated: c.authenticated,
        connectedAt: c.connectedAt,
        messageCount: c.messageCount,
      })),
    }),
  };
}
