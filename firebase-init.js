const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");
require("dotenv").config();

const REQUIRED_ENV = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY"
];

function normalizePrivateKey(privateKey) {
    if (typeof privateKey !== "string") {
        throw new Error("Firebase private key must be a string");
    }

    return privateKey.replace(/\\n/g, "\n");
}

function loadServiceAccount() {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (serviceAccountJson) {
        let serviceAccount;

        try {
            serviceAccount = JSON.parse(serviceAccountJson);
        } catch (e) {
            throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
        }

        if (!serviceAccount || typeof serviceAccount !== "object") {
            throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must be a JSON object");
        }

        if (serviceAccount.private_key) {
            serviceAccount.private_key = normalizePrivateKey(serviceAccount.private_key);
        }

        return serviceAccount;
    }

    const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(
            `Missing required Firebase configuration: ${missing.join(", ")}. ` +
            "Set them in the environment or provide FIREBASE_SERVICE_ACCOUNT_JSON."
        );
    }

    return {
        type: process.env.FIREBASE_TYPE || "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
        token_uri: process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
        universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN || "googleapis.com"
    };
}

function loadDatabaseUrl() {
    const databaseURL = process.env.FIREBASE_DATABASE_URL;

    if (!databaseURL) {
        throw new Error("Missing required Firebase configuration: FIREBASE_DATABASE_URL");
    }

    return databaseURL;
}

const existingApps = getApps();
const app = existingApps.length > 0
    ? existingApps[0]
    : initializeApp({
        credential: cert(loadServiceAccount()),
        databaseURL: loadDatabaseUrl()
    });

module.exports = {
    app,
    db: getDatabase(app),
    messaging: getMessaging(app)
};
