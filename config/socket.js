import { Server } from "socket.io";

// Use a more efficient data structure for client tracking
const connectedClients = new Map();
let stats = {
  totalConnections: 0,
  totalMessages: 0,
  totalErrors: 0,
  startTime: Date.now(),
};

// Performance-tuned connection limits
const MAX_CONNECTIONS = process.env.MAX_CONNECTIONS || 1000;
const PING_TIMEOUT = process.env.PING_TIMEOUT || 30000; // 30 seconds
const PING_INTERVAL = process.env.PING_INTERVAL || 25000; // 25 seconds
const BUFFER_SIZE = process.env.BUFFER_SIZE || 1e6; // 1MB

export async function initSocketServer(server) {
  // Socket.IO server with performance-optimized settings
  const io = new Server(server, {
    cors: {
      origin: [
        "http://localhost:5000",
        "https://hpty.vinhuser.one",
        "https://localhost:7163",
        "https://hotpot-web-app-production.up.railway.app",
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
    // Performance settings
    pingTimeout: PING_TIMEOUT,
    pingInterval: PING_INTERVAL,
    maxHttpBufferSize: BUFFER_SIZE,
    transports: ["websocket"], // Prefer WebSocket only for better performance
    allowUpgrades: false, // Disable transport upgrades for stability
    serveClient: false, // Don't serve client files
    httpCompression: true, // Enable compression
    perMessageDeflate: {
      // Optimize WebSocket compression
      threshold: 1024, // Only compress messages larger than 1KB
      zlibDeflateOptions: {
        // Optimize zlib settings
        level: 6, // Balance between speed and compression ratio
        memLevel: 8, // Use more memory for better compression
        strategy: 0, // Default strategy
      },
    },
  });

  // Efficient connection middleware
  io.use((socket, next) => {
    // Fast connection limit check
    if (io.engine.clientsCount >= MAX_CONNECTIONS) {
      return next(new Error("Server at capacity"));
    }
    next();
  });

  // Connection handling
  io.on("connection", (socket) => {
    stats.totalConnections++;
    const clientId = socket.id;

    // Store minimal client info (memory efficient)
    connectedClients.set(clientId, {
      id: clientId,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    });

    // Authentication - optimized for speed
    socket.on("authenticate", (data) => {
      try {
        // Store only essential user info
        socket.userId = data.userId;
        socket.userRole = data.role;

        // Update client tracking with minimal data
        const clientInfo = connectedClients.get(clientId);
        if (clientInfo) {
          clientInfo.userId = data.userId;
          clientInfo.userRole = data.role;
          clientInfo.lastActivity = Date.now();
        }

        // Join role-based room for efficient broadcasting
        if (data.role) {
          socket.join(data.role);
        }
      } catch (error) {
        stats.totalErrors++;
        console.error(`Auth error: ${error.message}`);
      }
    });

    // Event handlers optimized for performance

    // New chat event - broadcast to managers only
    socket.on("newChat", (data) => {
      stats.totalMessages++;
      updateActivity(clientId);

      // Efficient targeted broadcast
      socket.broadcast.to("Manager").emit("newChat", data);
    });

    // Chat accepted event - direct to specific user
    socket.on("chatAccepted", (data) => {
      stats.totalMessages++;
      updateActivity(clientId);

      // Direct message to customer (more efficient than room)
      if (data.customerId) {
        const targetSocket = findSocketByUserId(io, data.customerId.toString());
        if (targetSocket) {
          targetSocket.emit("chatAccepted", data);
        }
      }
    });

    // New message event - direct to specific user
    socket.on("newMessage", (data) => {
      stats.totalMessages++;
      updateActivity(clientId);

      // Direct message to receiver (more efficient than room)
      if (data.receiverId) {
        const targetSocket = findSocketByUserId(io, data.receiverId.toString());
        if (targetSocket) {
          targetSocket.emit("newMessage", data);
        }
      }
    });

    // Chat ended event - notify specific users
    socket.on("chatEnded", (data) => {
      stats.totalMessages++;
      updateActivity(clientId);

      // Direct messages to specific users
      if (data.customerId) {
        const customerSocket = findSocketByUserId(
          io,
          data.customerId.toString()
        );
        if (customerSocket) {
          customerSocket.emit("chatEnded", data);
        }
      }

      if (data.managerId) {
        const managerSocket = findSocketByUserId(io, data.managerId.toString());
        if (managerSocket) {
          managerSocket.emit("chatEnded", data);
        }
      }
    });

    // Optimized heartbeat
    socket.on("heartbeat", () => {
      updateActivity(clientId);
    });

    // Efficient disconnect handling
    socket.on("disconnect", () => {
      connectedClients.delete(clientId);
    });

    // Minimal error handling
    socket.on("error", () => {
      stats.totalErrors++;
    });
  });

  // Efficient client activity tracking
  function updateActivity(clientId) {
    const client = connectedClients.get(clientId);
    if (client) {
      client.lastActivity = Date.now();
    }
  }

  // Efficient socket lookup by user ID
  function findSocketByUserId(io, userId) {
    for (const [, socket] of io.sockets.sockets) {
      if (socket.userId === userId) {
        return socket;
      }
    }
    return null;
  }

  // Optimized cleanup interval (less frequent for better performance)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const inactivityThreshold = 60 * 60 * 1000; // 60 minutes

    for (const [id, client] of connectedClients.entries()) {
      if (now - client.lastActivity > inactivityThreshold) {
        const socket = io.sockets.sockets.get(id);
        if (socket) {
          socket.disconnect(true);
        }
        connectedClients.delete(id);
      }
    }
  }, 15 * 60 * 1000); // Run every 15 minutes

  // Clean up on server close
  io.on("close", () => {
    clearInterval(cleanupInterval);
  });

  // Return server and optimized stats function
  return {
    io,
    getStats: () => ({
      connectedClients: io.engine.clientsCount,
      totalConnections: stats.totalConnections,
      totalMessages: stats.totalMessages,
      totalErrors: stats.totalErrors,
      uptime: Math.floor((Date.now() - stats.startTime) / 1000),
      memory: process.memoryUsage(),
    }),
  };
}
