// config/socket.js
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

// Track connected clients and their statistics
const connectedClients = new Map();
let totalConnections = 0;
let totalMessages = 0;
let totalErrors = 0;

// Connection limits
const MAX_CONNECTIONS = process.env.MAX_CONNECTIONS
  ? parseInt(process.env.MAX_CONNECTIONS)
  : 100;

// Simple rate limiter
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

  // Clean up old entries to prevent memory leaks
  cleanup() {
    const now = Date.now();
    for (const [clientId, data] of this.clients.entries()) {
      if (now - data.lastRefill > this.duration * 1000 * 2) {
        this.clients.delete(clientId);
      }
    }
  }
}

// Create rate limiters
const connectionLimiter = new RateLimiter(5, 60); // 5 connections per minute
const messageLimiter = new RateLimiter(30, 60); // 30 messages per minute

// Clean up rate limiters periodically
setInterval(() => {
  connectionLimiter.cleanup();
  messageLimiter.cleanup();
}, 300000); // Every 5 minutes

export async function initSocketServer(server) {
  // Socket.IO server configuration with minimal options
  const io = new Server(server, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
        : ["http://localhost:5000", "https://hpty.vinhuser.one"],
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 30000, // 30 seconds ping timeout (reduced)
    pingInterval: 25000, // 25 seconds ping interval
    connectTimeout: 15000, // 15 seconds connection timeout (reduced)
    maxHttpBufferSize: 100000, // 100KB max payload size (reduced)
    transports: ["websocket", "polling"],
    perMessageDeflate: false, // Disable compression to save CPU
    httpCompression: false, // Disable compression to save CPU
    serveClient: false, // Don't serve client files
  });

  // Connection limiter middleware
  io.use((socket, next) => {
    // Check if we're at max capacity
    if (io.engine.clientsCount >= MAX_CONNECTIONS) {
      return next(new Error("Server is at capacity, please try again later"));
    }

    // Apply rate limiting
    const clientIp = socket.handshake.address;
    if (!connectionLimiter.consume(clientIp)) {
      return next(
        new Error("Too many connection attempts, please try again later")
      );
    }

    next();
  });

  // Connection handling
  io.on("connection", (socket) => {
    totalConnections++;
    const clientId = socket.id;
    const clientIp = socket.handshake.address;

    // Store minimal client info
    connectedClients.set(clientId, {
      id: clientId,
      connectedAt: Date.now(),
      messageCount: 0,
    });

    console.log(`Client connected: ${clientId}`);

    // Authentication
    socket.on("authenticate", (data) => {
      try {
        // Store user info on socket
        socket.userId = data.userId;
        socket.userRole = data.role;

        // Update client info
        const clientInfo = connectedClients.get(clientId);
        if (clientInfo) {
          clientInfo.userId = data.userId;
          clientInfo.userRole = data.role;
        }

        console.log(`User ${data.userId} authenticated as ${data.role}`);
      } catch (error) {
        console.error(`Authentication error: ${error.message}`);
      }
    });

    // Chat events with minimal processing
    socket.on("newChatRequest", (data) => {
      // Apply rate limiting
      if (!messageLimiter.consume(clientIp)) {
        socket.emit("error", { message: "Rate limit exceeded" });
        return;
      }

      // Track message count
      totalMessages++;
      const clientInfo = connectedClients.get(clientId);
      if (clientInfo) {
        clientInfo.messageCount++;
      }

      console.log("New chat request:", data);
      socket.broadcast.emit("newChatRequest", data);
    });

    socket.on("acceptChat", (data) => {
      if (!messageLimiter.consume(clientIp)) return;

      totalMessages++;
      console.log("Chat accepted:", data);

      // Create a room for this chat session
      const roomName = `chat:${data.sessionId}`;
      socket.join(roomName);

      // Find customer socket and add to room
      if (data.customerId) {
        for (const [id, client] of io.sockets.sockets.entries()) {
          if (client.userId === data.customerId.toString()) {
            client.join(roomName);
            break;
          }
        }
      }

      io.emit("chatAccepted", data);
    });

    socket.on("sendMessage", (data) => {
      if (!messageLimiter.consume(clientIp)) return;

      totalMessages++;
      console.log("Message sent:", {
        messageId: data.messageId,
        senderId: data.senderId,
        receiverId: data.receiverId,
      });

      // If we have a session room, use it
      const roomName = `chat:${data.sessionId}`;
      if (io.sockets.adapter.rooms.has(roomName)) {
        io.to(roomName).emit("receiveMessage", data);
      } else {
        io.emit("receiveMessage", data);
      }
    });

    socket.on("markMessageRead", (data) => {
      if (!messageLimiter.consume(clientIp)) return;

      totalMessages++;
      console.log("Message marked as read:", data.messageId);
      io.emit("messageRead", data.messageId);
    });

    socket.on("endChat", (data) => {
      if (!messageLimiter.consume(clientIp)) return;

      totalMessages++;
      console.log("Chat ended:", data);

      // Clean up the room
      const roomName = `chat:${data.sessionId}`;
      socket.leave(roomName);

      // Notify all clients
      io.emit("chatEnded", data);
    });

    // Heartbeat to detect zombie connections
    socket.on("heartbeat", () => {
      // Update last activity timestamp
      const clientInfo = connectedClients.get(clientId);
      if (clientInfo) {
        clientInfo.lastActivity = Date.now();
      }
    });

    // Handle disconnection
    socket.on("disconnect", (reason) => {
      const clientInfo = connectedClients.get(clientId);
      const duration = clientInfo
        ? (Date.now() - clientInfo.connectedAt) / 1000
        : 0;
      const messageCount = clientInfo ? clientInfo.messageCount : 0;

      console.log(
        `Client disconnected: ${clientId}, Reason: ${reason}, Duration: ${duration}s`
      );

      // Clean up client data
      connectedClients.delete(clientId);

      // Leave all rooms
      Object.keys(socket.rooms).forEach((room) => {
        if (room !== socket.id) {
          socket.leave(room);
        }
      });
    });

    // Error handling
    socket.on("error", (error) => {
      totalErrors++;
      console.error(`Socket error for ${clientId}: ${error.message}`);
    });
  });

  // Periodic cleanup of inactive connections
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const inactivityThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [id, socket] of io.sockets.sockets.entries()) {
      const clientInfo = connectedClients.get(id);
      if (
        clientInfo &&
        clientInfo.lastActivity &&
        now - clientInfo.lastActivity > inactivityThreshold
      ) {
        console.log(`Closing inactive connection: ${id}`);
        socket.disconnect(true);
      }
    }
  }, 60000); // Check every minute

  // Memory pressure handler
  const memoryCheckInterval = setInterval(() => {
    const memoryUsage = process.memoryUsage();
    const memoryThreshold = 450 * 1024 * 1024; // 450MB

    if (memoryUsage.rss > memoryThreshold) {
      console.warn(
        `Memory pressure detected: ${Math.round(
          memoryUsage.rss / 1024 / 1024
        )}MB`
      );

      // Notify clients
      io.emit("server:degraded", { reason: "memory" });

      // Disconnect idle clients if under extreme pressure
      if (memoryUsage.rss > 480 * 1024 * 1024) {
        // 480MB
        console.warn("Extreme memory pressure - disconnecting idle clients");
        const now = Date.now();
        let disconnectedCount = 0;

        for (const [id, socket] of io.sockets.sockets.entries()) {
          const clientInfo = connectedClients.get(id);
          // Disconnect clients with no authentication or inactive for > 2 minutes
          if (
            !socket.userId ||
            (clientInfo &&
              clientInfo.lastActivity &&
              now - clientInfo.lastActivity > 2 * 60 * 1000)
          ) {
            socket.disconnect(true);
            disconnectedCount++;

            // Stop after disconnecting 20% of clients
            if (disconnectedCount > io.engine.clientsCount * 0.2) break;
          }
        }

        console.warn(
          `Disconnected ${disconnectedCount} idle clients due to memory pressure`
        );

        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }
    }
  }, 30000); // Check every 30 seconds

  // Clean up intervals on server close
  io.on("close", () => {
    clearInterval(cleanupInterval);
    clearInterval(memoryCheckInterval);
  });

  // Return the server instance and utility methods
  return {
    io,
    getStats: () => ({
      connectedClients: io.engine.clientsCount,
      totalConnections,
      totalMessages,
      totalErrors,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    }),
  };
}
