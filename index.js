import express from "express";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
const PORT = 3000;

const domains = [
    "apis",
    "assetdelivery",
    "avatar",
    "badges",
    "catalog",
    "chat",
    "contacts",
    "contentstore",
    "develop",
    "economy",
    "economycreatorstats",
    "followings",
    "friends",
    "games",
    "groups",
    "groupsmoderation",
    "inventory",
    "itemconfiguration",
    "locale",
    "notifications",
    "points",
    "presence",
    "privatemessages",
    "publish",
    "search",
    "thumbnails",
    "trades",
    "translations",
    "users"
];

const proxyAgent = new HttpsProxyAgent("http://6273eb4f4c8aa0f545d5__cr.vn:b084c9fd9e440267@gw.dataimpulse.com:823");

app.use(express.text({ type: "*/*" }));

app.all("/:subdomain/*", async (req, res) => {
    const { subdomain } = req.params;
    const path = req.params[0];

    if (!subdomain.trim()) {
        return res.status(400).json({ message: "Missing ROBLOX subdomain." });
    }

    if (!domains.includes(subdomain)) {
        return res.status(401).json({ message: "Specified subdomain is not allowed." });
    }

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["roblox-id"];
    delete headers["user-agent"];
    headers["user-agent"] = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

    const init = {
        method: req.method,
        headers,
        agent: proxyAgent
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = req.body;
    }

    try {
        const response = await fetch(`https://${subdomain}.roblox.com/${path}${req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : ""}`, init);
        const body = await response.text();
        res.status(response.status).set(Object.fromEntries(response.headers)).send(body);
    } catch (error) {
        res.status(500).json({ message: "Proxy request failed", error: error.message });
    }
});

app.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));
