import express from "express";
import { createServer } from "http";
import cors from "cors";
import { initSocketServer } from "./config/socket.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();

// Configure CORS for the Express app
app.use(
  cors({
    origin: "http://localhost:5000", // Replace with your client's origin
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// Basic route for health check
app.get("/", (req, res) => {
  res.send("Socket.IO server is running");
});

// Create HTTP server
const server = createServer(app);

// Initialize Socket.IO server
initSocketServer(server);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running at http://localhost:${PORT}/`);
});
