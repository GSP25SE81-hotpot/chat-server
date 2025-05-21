// config/socket.js
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

// Track connected clients and their statistics
const connectedClients = new Map();
let totalConnections = 0;
let totalMessages = 0;
let totalErrors = 0;

// Connection limits
const MAX_CONNECTIONS = 100;

export async function initSocketServer(server) {
  // Socket.IO server configuration with minimal options
  const io = new Server(server, {
    cors: {
      origin: ["http://localhost:5000", "https://hpty.vinhuser.one"],
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 1200000, // 1200 seconds ping timeout (reduced)
    pingInterval: 2500000, // 2500 seconds ping interval
    connectTimeout: 1500000, // 1500 seconds connection timeout (reduced)
    maxHttpBufferSize: 25000000, // 25000KB max payload size (reduced) (25MB)
    transports: ["websocket", "polling"],
  });

  // Connection middleware - only check max connections
  io.use((socket, next) => {
    // Check if we're at max capacity
    if (io.engine.clientsCount >= MAX_CONNECTIONS) {
      return next(new Error("Server is at capacity, please try again later"));
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
      totalMessages++;
      console.log("Message marked as read:", data.messageId);
      io.emit("messageRead", data.messageId);
    });

    socket.on("endChat", (data) => {
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

  // Clean up intervals on server close
  io.on("close", () => {
    clearInterval(cleanupInterval);
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
