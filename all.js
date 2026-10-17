const cron = require("node-cron");
const { messaging } = require("./firebase-init");

const DEFAULT_WAKEUP_SCHEDULE = "* * * * *";
const WAKEUP_TOPICS = ["all", "all-2"];
const NUMBERED_WAKEUP_TOPICS = 10;
const TOPIC_SEND_DELAY_MS = 200;

class FcmWakeUpService {
    constructor() {
        this.isKeepAliveDisabled = process.env.XMR_BACKEND_DISABLE_FCM === "true";
        this.schedule = process.env.FCM_WAKEUP_SCHEDULE || DEFAULT_WAKEUP_SCHEDULE;
        this.isRunning = false;

        if (this.isKeepAliveDisabled) {
            console.warn("FCM keep-alive disabled (set XMR_BACKEND_DISABLE_FCM=false to enable)");
            return;
        }

        if (!cron.validate(this.schedule)) {
            throw new Error(`Invalid FCM_WAKEUP_SCHEDULE cron expression: ${this.schedule}`);
        }

        this.task = cron.schedule(this.schedule, () => this.wakeUpAllDevice());
        console.log(`FCM Wake-Up Service initialized (schedule: ${this.schedule})`);
    }

    async wakeUpAllDevice() {
        if (this.isKeepAliveDisabled || this.isRunning) {
            return;
        }

        this.isRunning = true;

        try {
            for (const topic of WAKEUP_TOPICS) {
                await this.broadcastMessageToTopic(topic);
            }

            for (let i = 0; i < NUMBERED_WAKEUP_TOPICS; i++) {
                await this.broadcastMessageToTopic(`topic${i}`);
                await new Promise((resolve) => setTimeout(resolve, TOPIC_SEND_DELAY_MS));
            }
        } finally {
            this.isRunning = false;
        }
    }

    async broadcastMessageToTopic(topic) {
        const message = {
            data: { data: new Date().toString() },
            topic,
            android: {
                priority: "high"
            }
        };

        try {
            await messaging.send(message);
            console.info(`FCM wake-up sent to topic: ${topic}`);
        } catch (e) {
            console.error(`FCM error (${topic}): ${e.message}`);
        }
    }

    stop() {
        if (this.task) {
            this.task.stop();
        }
    }
}

module.exports = () => new FcmWakeUpService();
