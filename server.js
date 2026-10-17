require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

require("./firebase-init");
const socketHandler = require("./socketHandler");
const startWakeUpService = require("./all");

const app = express();
const server = http.createServer(app);

function parseCorsOrigins() {
    const configured = (process.env.CORS_ORIGIN || "*")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

    if (configured.length === 0 || configured.includes("*")) {
        return "*";
    }

    return configured;
}

const io = new Server(server, {
    cors: {
        origin: parseCorsOrigins(),
        methods: ["GET", "POST"]
    },
    transports: ["polling", "websocket"],
    allowEIO3: true,
    pingInterval: 25000,
    pingTimeout: 60000
});

const socketAuthToken = process.env.SOCKET_AUTH_TOKEN;

if (socketAuthToken) {
    io.use((socket, next) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token;
        const headerToken = socket.handshake.headers["x-auth-token"];
        const token = typeof authToken === "string" ? authToken : headerToken;

        if (typeof token === "string") {
            const tokenBuffer = Buffer.from(token);
            const expectedBuffer = Buffer.from(socketAuthToken);

            if (
                tokenBuffer.length === expectedBuffer.length &&
                crypto.timingSafeEqual(tokenBuffer, expectedBuffer)
            ) {
                return next();
            }
        }

        next(new Error("Unauthorized"));
    });
}


app.disable("x-powered-by");

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");

    next();
});

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

app.use(express.static(path.join(__dirname, "public")));


app.get("/", (req, res) => {
    res.send("Server Running");
});

app.get("/health", (req, res) => {

    res.json({
        success: true,
        socketClients: io.engine.clientsCount,
        uptime: process.uptime(),
        timestamp: Date.now()
    });
});

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Not Found"
    });
});

app.use((err, req, res, next) => {
    console.error("Request failed:", err.message);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        success: false,
        message: "Internal Server Error"
    });
});

socketHandler(io);

const wakeUpService = startWakeUpService();


const PORT = Number.parseInt(process.env.PORT || "3000", 10);

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

server.on("error", (error) => {
    console.error("Server error:", error.message);
    process.exit(1);
});

server.listen(PORT, () => {

    console.log("====================================");
    console.log(" Server Started");
    console.log(" Port :", PORT);
    console.log("====================================");

});

let isShuttingDown = false;

function shutdown(signal) {
    if (isShuttingDown) return;

    isShuttingDown = true;

    console.log(`${signal} received, shutting down`);

    wakeUpService.stop();

    const forceExitTimer = setTimeout(() => {
        console.error("Forced shutdown after timeout");
        process.exit(1);
    }, 10000);

    forceExitTimer.unref();

    io.close(() => {
        console.log("Shutdown complete");
        clearTimeout(forceExitTimer);
        process.exit(0);
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});
