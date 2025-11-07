import express from "express";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();

const rawPort = process.env.PORT;
if (!rawPort) {
    throw new Error("PORT environment variable is required.");
}
const parsedPort = Number.parseInt(rawPort, 10);
if (Number.isNaN(parsedPort) || parsedPort <= 0) {
    throw new Error(`PORT must be a positive integer, received "${rawPort}".`);
}
const PORT = parsedPort;

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

const envKeys = Object.keys(process.env).sort();

const rawProxyUrl = process.env.PROXY_URL;
if (!rawProxyUrl || !rawProxyUrl.trim()) {
    console.error("Missing PROXY_URL. Available environment keys:", envKeys);
    console.error("PORT env present:", typeof process.env.PORT === "string");
    throw new Error("PROXY_URL environment variable is required for outbound Roblox requests.");
}

const PROXY_URL = rawProxyUrl.trim();
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const toPositiveInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
};

const toBoolean = (value, fallback) => {
    if (typeof value !== "string") {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
        return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
        return false;
    }
    return fallback;
};

const ONE_MINUTE_MS = 60 * 1000;
const DEFAULT_PLACE_ID = (process.env.DEFAULT_PLACE_ID || "109983668079237").trim();
const JOB_CACHE_TTL_MS_BASE = toPositiveInteger(process.env.JOB_CACHE_TTL_MS, 2 * ONE_MINUTE_MS);
const JOB_SWEEP_INTERVAL_MS = toPositiveInteger(process.env.JOB_SWEEP_INTERVAL_MS, 15 * 1000);
const JOB_FETCH_MAX_PAGES = toPositiveInteger(process.env.JOB_FETCH_MAX_PAGES, 100);
const JOB_POOL_TARGET = toPositiveInteger(process.env.JOB_POOL_TARGET, 500);
const JOB_MIN_PLAYERS = toPositiveInteger(process.env.JOB_MIN_PLAYERS, 1);
const JOB_RECYCLE_AFTER_MS = toPositiveInteger(process.env.JOB_RECYCLE_AFTER_MS, 5 * ONE_MINUTE_MS);
const JOB_SKIP_FULL_SERVERS = toBoolean(process.env.JOB_SKIP_FULL_SERVERS, false);
const EXCLUDE_FULL_GAMES = toBoolean(process.env.JOB_SKIP_FULL_SERVERS, true);
const JOB_TOP_UP_THRESHOLD = Math.max(
    1,
    Math.min(
        toPositiveInteger(process.env.JOB_TOP_UP_THRESHOLD, Math.ceil(JOB_POOL_TARGET * 0.3)),
        JOB_POOL_TARGET
    )
);
const JOB_DUPLICATE_ALERT_WINDOW_MS = toPositiveInteger(
    process.env.JOB_DUPLICATE_ALERT_WINDOW_MS,
    60 * 1000
);
const JOB_SERVER_SORT_ORDER = (() => {
    const raw = (process.env.JOB_SERVER_SORT_ORDER || "Asc").trim().toLowerCase();
    return raw === "desc" ? "Desc" : "Asc";
})();
const LOG_THROTTLE_MS = toPositiveInteger(process.env.LOG_THROTTLE_MS, 5 * 1000);
const ROBLOX_FETCH_WARN_AFTER_MS = toPositiveInteger(
    process.env.ROBLOX_FETCH_WARN_AFTER_MS,
    10 * 1000
);
console.warn("Max api pages are: ", JOB_FETCH_MAX_PAGES);
const ROBLOX_API_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

const JOB_CACHE_TTL_MS = Math.max(JOB_CACHE_TTL_MS_BASE, JOB_RECYCLE_AFTER_MS);

const jobCache = new Map();
const inflightFetches = new Map();
const recentReservations = new Map();
const throttledLogState = new Map();

const logErrorThrottled = (key, message, details = null) => {
    const now = Date.now();
    const state = throttledLogState.get(key);

    if (!state) {
        throttledLogState.set(key, {
            lastLog: now,
            suppressed: 0,
            lastDetails: details
        });
        console.error(message, details ?? undefined);
        return;
    }

    if (now - state.lastLog >= LOG_THROTTLE_MS) {
        const suppressedNote = state.suppressed > 0
            ? ` (and ${state.suppressed} similar errors)`
            : "";
        console.error(`${message}${suppressedNote}`, (details ?? state.lastDetails) ?? undefined);
        state.lastLog = now;
        state.suppressed = 0;
        state.lastDetails = details;
        return;
    }

    state.suppressed += 1;
    state.lastDetails = details;
};

const sweepHandle = setInterval(() => {
    const now = Date.now();
    for (const [placeId, entry] of jobCache.entries()) {
        if (!entry || entry.expiresAt <= now) {
            jobCache.delete(placeId);
            continue;
        }
    }

    for (const [jobId, lastSeen] of recentReservations.entries()) {
        if (now - lastSeen > JOB_RECYCLE_AFTER_MS) {
            recentReservations.delete(jobId);
        }
    }
}, JOB_SWEEP_INTERVAL_MS);

if (typeof sweepHandle.unref === "function") {
    sweepHandle.unref();
}

const shuffle = (items) => {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
};

const buildServerUrl = (placeId, cursor) => {
    const baseUrl = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=${JOB_SERVER_SORT_ORDER}&limit=100&excludeFullGames=${EXCLUDE_FULL_GAMES}`;
    return cursor ? `${baseUrl}&cursor=${encodeURIComponent(cursor)}` : baseUrl;
};

const requestRobloxServerPage = async (placeId, cursor) => {
    const url = buildServerUrl(placeId, cursor);
    const warnTimeout = setTimeout(() => {
        console.warn("[Roblox] Server fetch still pending", {
            placeId,
            cursor,
            url,
            warnAfterMs: ROBLOX_FETCH_WARN_AFTER_MS
        });
    }, ROBLOX_FETCH_WARN_AFTER_MS);

    try {
        const response = await fetch(url, {
            method: "GET",
            agent: proxyAgent,
            headers: {
                "user-agent": ROBLOX_API_USER_AGENT,
                accept: "application/json"
            }
        });

        if (!response.ok) {
            const bodySnippet = await response.text().catch(() => "<unable to read body>");
            logErrorThrottled("roblox-fetch-failed", "[Roblox] Server fetch failed", {
                placeId,
                cursor,
                status: response.status,
                statusText: response.statusText,
                bodySnippet: bodySnippet.slice(0, 300)
            });
            throw new Error(`Roblox server fetch failed with status ${response.status}`);
        }

        return response.json();
    } finally {
        clearTimeout(warnTimeout);
    }
};

const filterServerRecords = (servers, seenJobIds) => {
    const filtered = [];
    const sessionSeen = new Set();
    const stats = {
        total: 0,
        invalid: 0,
        duplicate: 0,
        lowPlayers: 0,
        full: 0,
        recentlyReserved: 0
    };
    const now = Date.now();

    for (const server of servers) {
        stats.total += 1;

        if (!server || typeof server.id !== "string") {
            stats.invalid += 1;
            continue;
        }

        if (seenJobIds.has(server.id) || sessionSeen.has(server.id)) {
            stats.duplicate += 1;
            continue;
        }

        const lastReserved = recentReservations.get(server.id);
        if (lastReserved && now - lastReserved < JOB_RECYCLE_AFTER_MS) {
            stats.recentlyReserved += 1;
            continue;
        }

        const playing = typeof server.playing === "number" ? server.playing : null;
        const maxPlayers = typeof server.maxPlayers === "number" ? server.maxPlayers : null;

        if (playing !== null && playing < JOB_MIN_PLAYERS) {
            stats.lowPlayers += 1;
            continue;
        }

        if (maxPlayers !== null && playing !== null && playing >= maxPlayers) {
            stats.full += 1;
            if (JOB_SKIP_FULL_SERVERS) {
                continue;
            }
        }

        filtered.push(server);
        sessionSeen.add(server.id);
        seenJobIds.add(server.id);
    }

    return { filtered, stats };
};

const buildJobRecord = (server) => ({
    jobId: server.id,
    playing: typeof server.playing === "number" ? server.playing : null,
    maxPlayers: typeof server.maxPlayers === "number" ? server.maxPlayers : null,
    ping: typeof server.ping === "number" ? server.ping : null,
    fps: typeof server.fps === "number" ? server.fps : null,
    source: "pool"
});

const createCacheEntry = (placeId, servers) => {
    const now = Date.now();
    const jobs = shuffle(servers.map(buildJobRecord)).slice(0, JOB_POOL_TARGET);
    const jobIds = new Set(jobs.map((job) => job.jobId));

    return {
        placeId,
        jobs,
        jobIds,
        fetchedAt: now,
        expiresAt: now + JOB_CACHE_TTL_MS,
        topUpInProgress: false
    };
};

const scheduleJobPoolTopUp = (placeId, entry, seedCursor = null, pagesConsumed = 0) => {
    if (!entry || entry.topUpInProgress) {
        return;
    }

    if (entry.expiresAt <= Date.now()) {
        return;
    }

    if (entry.jobs.length >= JOB_POOL_TARGET) {
        return;
    }

    entry.topUpInProgress = true;

    (async () => {
        try {
            let cursor = seedCursor;
            let pages = pagesConsumed;
            const seenJobIds = entry.jobIds;

            while (pages < JOB_FETCH_MAX_PAGES && entry.jobs.length < JOB_POOL_TARGET) {
                const payload = await requestRobloxServerPage(placeId, cursor ?? undefined);
                pages += 1;

                const rawServers = Array.isArray(payload?.data) ? payload.data : [];
                const { filtered, stats } = filterServerRecords(rawServers, seenJobIds);
                if (filtered.length) {
                    const jobs = shuffle(filtered.map(buildJobRecord));
                    const slotsRemaining = Math.max(0, JOB_POOL_TARGET - entry.jobs.length);
                    if (slotsRemaining > 0) {
                        const jobsToAdd = jobs.slice(0, slotsRemaining);
                        for (const job of jobsToAdd) {
                            entry.jobs.push(job);
                            entry.jobIds.add(job.jobId);
                        }
                    }
                } else {
                    console.warn(`[JobPool] Roblox page yielded zero eligible servers during top-up`, {
                        placeId,
                        stats
                    });
                }

                cursor = payload?.nextPageCursor ?? null;
                if (!cursor) {
                    break;
                }

                if (entry.jobs.length >= JOB_POOL_TARGET) {
                    break;
                }
            }
        } catch (error) {
            logErrorThrottled(
                `jobpool-topup-failed-${placeId}`,
                `Job pool top-up failed for place ${placeId}`,
                { error: error instanceof Error ? error.message : String(error) }
            );
        } finally {
            entry.topUpInProgress = false;
        }
    })();
};

const primeJobPool = async (placeId) => {
    const seenJobIds = new Set();
    const servers = [];
    let cursor = null;
    let pages = 0;
    let lastStats = null;

    while (pages < JOB_FETCH_MAX_PAGES && servers.length < JOB_POOL_TARGET) {
        const payload = await requestRobloxServerPage(placeId, cursor ?? undefined);
        pages += 1;

        const rawServers = Array.isArray(payload?.data) ? payload.data : [];
        const { filtered, stats } = filterServerRecords(rawServers, seenJobIds);
        lastStats = stats;
        if (filtered.length) {
            servers.push(...filtered);
        } else {
            console.warn(`[JobPool] Roblox page yielded zero eligible servers during prime`, {
                placeId,
                stats
            });
        }

        cursor = payload?.nextPageCursor ?? null;
        if (!cursor) {
            break;
        }
    }

    if (!servers.length) {
        logErrorThrottled(
            `jobpool-prime-empty-${placeId}`,
            `[JobPool] Failed to prime pool for place ${placeId}; no eligible servers after ${pages} pages.`,
            { lastStats }
        );
        throw new Error("No eligible servers returned by Roblox");
    }

    const entry = createCacheEntry(placeId, servers);
    jobCache.set(placeId, entry);

    if (cursor) {
        scheduleJobPoolTopUp(placeId, entry, cursor, pages);
    }

    return entry;
};

const countAvailableJobs = (entry) => (!entry ? 0 : entry.jobs.length);

const reserveNextJob = (entry) => {
    if (!entry || entry.jobs.length === 0) {
        return null;
    }

    const now = Date.now();

    const job = entry.jobs.pop();
    if (!job) {
        return null;
    }

    entry.jobIds.delete(job.jobId);
    job.reservedAt = now;
    return job;
};

const recordReservation = (job) => {
    if (!job || typeof job.jobId !== "string" || typeof job.reservedAt !== "number") {
        return;
    }

    const lastSeen = recentReservations.get(job.jobId);
    if (lastSeen && job.reservedAt - lastSeen <= JOB_DUPLICATE_ALERT_WINDOW_MS) {
        console.warn("[JobPool] Duplicate reservation detected within window", {
            jobId: job.jobId,
            previous: new Date(lastSeen).toISOString(),
            current: new Date(job.reservedAt).toISOString()
        });
    }

    recentReservations.set(job.jobId, job.reservedAt);
};

const ensureJobPool = async (placeId) => {
    const now = Date.now();
    const cached = jobCache.get(placeId);

    if (cached && cached.expiresAt > now) {
        const available = countAvailableJobs(cached);
        if (available > 0) {
            if (available < JOB_TOP_UP_THRESHOLD) {
                scheduleJobPoolTopUp(placeId, cached);
            }
            return cached;
        }
    }

    if (cached) {
        jobCache.delete(placeId);
    }

    if (inflightFetches.has(placeId)) {
        return inflightFetches.get(placeId);
    }

    const fetchPromise = primeJobPool(placeId);
    inflightFetches.set(placeId, fetchPromise);

    try {
        return await fetchPromise;
    } finally {
        inflightFetches.delete(placeId);
    }
};

app.use(express.text({ type: "*/*" }));

app.get("/", (req, res) => {
    res.json({ status: "ok", message: "Proxy is running" });
});

app.get("/jobs/next", async (req, res) => {
    const rawPlaceId = (req.query.placeId || DEFAULT_PLACE_ID || "").toString().trim();

    if (!rawPlaceId) {
        return res.status(400).json({ message: "Missing placeId." });
    }

    try {
        const entry = await ensureJobPool(rawPlaceId);
        const availableBefore = countAvailableJobs(entry);
        if (!entry || availableBefore === 0) {
            return res.status(503).json({ message: "No JobIds available at the moment." });
        }

        const job = reserveNextJob(entry);
        if (!job) {
            jobCache.delete(rawPlaceId);
            return res.status(503).json({ message: "Job pool depleted, retry shortly." });
        }

        recordReservation(job);

        const remaining = countAvailableJobs(entry);

        return res.json({
            jobId: job.jobId,
            placeId: rawPlaceId,
            reservedAt: new Date(job.reservedAt).toISOString(),
            expiresAt: new Date(entry.expiresAt).toISOString(),
            playing: job.playing,
            maxPlayers: job.maxPlayers,
            ping: job.ping,
            fps: job.fps,
            source: job.source,
            poolSize: availableBefore,
            remaining
        });
    } catch (error) {
        console.error("Job reservation error:", error);
        const message = error instanceof Error ? error.message : String(error);
        const noServers = typeof message === "string" && message.includes("No eligible servers");
        return res.status(noServers ? 503 : 502).json({
            message,
            error: noServers ? "no_servers_available" : "roblox_fetch_failed"
        });
    }
});

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
        console.log(`[${subdomain}] Status: ${response.status}, Body length: ${body.length}`);

        const responseHeaders = Object.fromEntries(response.headers);
        delete responseHeaders['content-encoding'];
        delete responseHeaders['transfer-encoding'];

        res.status(response.status).set(responseHeaders).send(body);
    } catch (error) {
        console.error("Proxy error:", error);
        res.status(500).json({ message: "Proxy request failed", error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Proxy running on http://0.0.0.0:${PORT}`));
