import { Server } from "socket.io";

export function initSocketServer(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("authenticate", (data) => {
      console.log("Authentication request:", data);
      socket.userId = data.userId;
      socket.userRole = data.role;
      console.log(`User ${data.userId} authenticated as ${data.role}`);
    });

    socket.on("newChatRequest", (data) => {
      console.log("New chat request:", data);
      socket.broadcast.emit("newChatRequest", data);
    });

    socket.on("acceptChat", (data) => {
      console.log("Chat accepted:", data);
      io.emit("chatAccepted", data);
    });

    socket.on("sendMessage", (data) => {
      console.log("Message sent:", data);
      io.emit("receiveMessage", data);
    });

    socket.on("markMessageRead", (data) => {
      console.log("Message marked as read:", data);
      io.emit("messageRead", data.messageId);
    });

    socket.on("endChat", (data) => {
      console.log("Chat ended:", data);
      io.emit("chatEnded", data.sessionId);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });

    socket.onAny((event, ...args) => {
      console.log(`[EVENT] ${event}:`, args);
    });
  });
}
