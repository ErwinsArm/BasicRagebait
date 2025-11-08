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

const ONE_MINUTE_MS = 60 * 1000;
const DEFAULT_PLACE_ID = (process.env.DEFAULT_PLACE_ID || "109983668079237").trim();
const JOB_CACHE_TTL_MS_BASE = toPositiveInteger(process.env.JOB_CACHE_TTL_MS, 2 * ONE_MINUTE_MS);
const JOB_SWEEP_INTERVAL_MS = toPositiveInteger(process.env.JOB_SWEEP_INTERVAL_MS, 15 * 1000);
const JOB_FETCH_MAX_PAGES = toPositiveInteger(process.env.JOB_FETCH_MAX_PAGES, 100);
const JOB_POOL_TARGET = toPositiveInteger(process.env.JOB_POOL_TARGET, 500);
const JOB_MIN_PLAYERS = toPositiveInteger(process.env.JOB_MIN_PLAYERS, 1);
const JOB_RECYCLE_AFTER_MS = toPositiveInteger(process.env.JOB_RECYCLE_AFTER_MS, 5 * ONE_MINUTE_MS);
const JOB_TOP_UP_THRESHOLD = toPositiveInteger(process.env.JOB_TOP_UP_THRESHOLD, Math.ceil(JOB_POOL_TARGET * 0.4));
const JOB_DUPLICATE_ALERT_WINDOW_MS = toPositiveInteger(process.env.JOB_DUPLICATE_ALERT_WINDOW_MS, 60 * 1000);
const PLAYER_SPAM_INTERVAL_SECONDS = toPositiveInteger(process.env.PLAYER_SPAM_INTERVAL_SECONDS, 60);
const PLAYER_COUNTER_WINDOW_MS = PLAYER_SPAM_INTERVAL_SECONDS * 1000;
const PLAYER_SPAM_THRESHOLD = Math.max(1, toPositiveInteger(process.env.PLAYER_SPAM_THRESHOLD, 20));
const PLAYER_SPAM_LOG_ENABLED = (() => {
    const raw = (process.env.PLAYER_SPAM_LOGS_ENABLED || "true").trim().toLowerCase();
    return raw === "false" || raw === "0" ? false : true;
})();
const JOB_ALWAYS_SCRAPE = (process.env.JOB_ALWAYS_SCRAPE || "").trim().toLowerCase() === "true";
const JOB_PRIME_BATCH_SIZE = Math.max(1, toPositiveInteger(process.env.JOB_PRIME_BATCH_SIZE, 150));
const DEFAULT_SCRAPE_MODE = {
    sortOrder: "Asc",
    excludeFullGames: true
};
// JOB_SCRAPE_MODES example:
//   [{"sortOrder":"Asc","excludeFullGames":true},{"sortOrder":"Asc","excludeFullGames":false},{"sortOrder":"Desc","excludeFullGames":true}]
const SCRAPE_MODES = (() => {
    const raw = typeof process.env.JOB_SCRAPE_MODES === "string" ? process.env.JOB_SCRAPE_MODES.trim() : "";
    if (!raw) {
        return [{ ...DEFAULT_SCRAPE_MODE }];
    }

    try {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        const modes = [];

        for (const item of items) {
            if (!item || typeof item !== "object") {
                continue;
            }

            const sortOrder = typeof item.sortOrder === "string" && item.sortOrder.trim().toLowerCase() === "desc"
                ? "Desc"
                : "Asc";
            const excludeFullGames = typeof item.excludeFullGames === "boolean"
                ? item.excludeFullGames
                : DEFAULT_SCRAPE_MODE.excludeFullGames;

            modes.push({ sortOrder, excludeFullGames });
        }

        return modes.length ? modes : [{ ...DEFAULT_SCRAPE_MODE }];
    } catch (error) {
        console.warn("[Config] JOB_SCRAPE_MODES parse failed:", error);
        return [{ ...DEFAULT_SCRAPE_MODE }];
    }
})();
const buildModeKey = (mode, index) => {
    const sort = mode?.sortOrder === "Desc" ? "Desc" : "Asc";
    const fill = mode?.excludeFullGames === false ? "include" : "exclude";
    return `${sort}-${fill}-${index}`;
};
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
const playerRequestStats = new Map();
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

    if (PLAYER_SPAM_LOG_ENABLED) {
        for (const [player, stats] of playerRequestStats.entries()) {
            if (!stats || typeof stats.lastReset !== "number" || now - stats.lastReset > PLAYER_COUNTER_WINDOW_MS) {
                playerRequestStats.delete(player);
            }
        }
    } else {
        playerRequestStats.clear();
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

const buildServerUrl = (placeId, cursor, mode = DEFAULT_SCRAPE_MODE) => {
    const sortOrder = mode?.sortOrder === "Desc" ? "Desc" : "Asc";
    const excludeFullGames = mode?.excludeFullGames ? "true" : "false";
    const baseUrl = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=${sortOrder}&limit=100&excludeFullGames=${excludeFullGames}`;
    return cursor ? `${baseUrl}&cursor=${encodeURIComponent(cursor)}` : baseUrl;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestRobloxServerPage = async (placeId, cursor, mode = DEFAULT_SCRAPE_MODE) => {
    const label = `${mode?.sortOrder === "Desc" ? "Desc" : "Asc"}`
        + `/${mode?.excludeFullGames === false ? "include-full" : "exclude-full"}`;
    const baseUrl = buildServerUrl(placeId, cursor, mode);
    const warnTimeout = setTimeout(() => {
        console.warn(`[Roblox] Fetch still pending (${label}) place=${placeId} cursor=${cursor ?? "start"}`);
    }, ROBLOX_FETCH_WARN_AFTER_MS);

    try {
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const response = await fetch(baseUrl, {
                    method: "GET",
                    agent: proxyAgent,
                    headers: {
                        "user-agent": ROBLOX_API_USER_AGENT,
                        accept: "application/json"
                    }
                });

                if (response.ok) {
                    return response.json();
                }

                const status = response.status;
                const bodySnippet = await response.text().catch(() => "<unable to read body>");
                const message = `[Roblox] Fetch failed (${label}) status=${status}`;
                logErrorThrottled("roblox-fetch-failed", message, {
                    placeId,
                    cursor,
                    statusText: response.statusText,
                    bodySnippet: bodySnippet.slice(0, 300)
                });

                const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
                if (!retryable || attempt === maxAttempts) {
                    throw new Error(`Roblox server fetch failed with status ${status}`);
                }
            } catch (error) {
                const isFetchError = Boolean(error && typeof error === "object" && "type" in error);
                if (!isFetchError) {
                    throw error;
                }

                const throttledKey = error?.code === "ERR_STREAM_PREMATURE_CLOSE"
                    ? "roblox-premature-close"
                    : "roblox-fetch-error";
                logErrorThrottled(
                    throttledKey,
                    `[Roblox] Fetch error (${label})`,
                    {
                        placeId,
                        cursor,
                        message: error instanceof Error ? error.message : String(error)
                    }
                );

                if (attempt === maxAttempts) {
                    throw error;
                }
            }

            const backoffMs = 250 + Math.floor(Math.random() * 250);
            await sleep(backoffMs);
        }

        throw new Error("Roblox server fetch failed after retries");
    } finally {
        clearTimeout(warnTimeout);
    }
};

const filterServerRecords = (servers, seenJobIds, mode = DEFAULT_SCRAPE_MODE) => {
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
    const skipFullServers = mode?.excludeFullGames !== false;

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
            if (skipFullServers) {
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

const createCacheEntry = (placeId) => {
    const now = Date.now();
    const jobs = [];
    const jobIds = new Set();
    const modeStates = new Map();
    const modes = SCRAPE_MODES.length ? SCRAPE_MODES : [{ ...DEFAULT_SCRAPE_MODE }];

    modes.forEach((mode, index) => {
        modeStates.set(buildModeKey(mode, index), {
            mode,
            cursor: null,
            inflight: false
        });
    });

    return {
        placeId,
        jobs,
        jobIds,
        fetchedAt: now,
        expiresAt: now + JOB_CACHE_TTL_MS,
        modeStates
    };
};

const ensureModeStates = (entry) => {
    if (!entry) {
        return;
    }
    if (entry.modeStates instanceof Map && entry.modeStates.size > 0) {
        return;
    }

    const modeStates = new Map();
    const modes = SCRAPE_MODES.length ? SCRAPE_MODES : [{ ...DEFAULT_SCRAPE_MODE }];
    modes.forEach((mode, index) => {
        modeStates.set(buildModeKey(mode, index), {
            mode,
            cursor: null,
            inflight: false
        });
    });
    entry.modeStates = modeStates;
};

const appendJobsToEntry = (entry, jobRecords) => {
    let added = 0;
    for (const job of jobRecords) {
        if (!job || typeof job.jobId !== "string") {
            continue;
        }
        if (entry.jobIds.has(job.jobId)) {
            continue;
        }
        entry.jobs.push(job);
        entry.jobIds.add(job.jobId);
        added += 1;
        if (!JOB_ALWAYS_SCRAPE && entry.jobs.length >= JOB_POOL_TARGET) {
            break;
        }
    }
    return added;
};

const scheduleJobPoolTopUp = (placeId, entry) => {
    if (!entry || entry.expiresAt <= Date.now()) {
        return;
    }
    ensureModeStates(entry);
    for (const state of entry.modeStates.values()) {
        scheduleModePoolTopUp(placeId, entry, state);
    }
};

const primeJobPool = async (placeId) => {
    const entry = createCacheEntry(placeId);
    jobCache.set(placeId, entry);

    for (const state of entry.modeStates.values()) {
        await primeModePool(placeId, entry, state);
        if (entry.jobs.length >= JOB_POOL_TARGET) {
            break;
        }
    }

    if (!entry.jobs.length) {
        logErrorThrottled(
            `jobpool-prime-empty-${placeId}`,
            `[JobPool] Failed to prime pool for place ${placeId}; no eligible servers fetched.`,
            null
        );
        throw new Error("No eligible servers returned by Roblox");
    }

    scheduleJobPoolTopUp(placeId, entry);
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

const recordPlayerHit = (playerName) => {
    if (!PLAYER_SPAM_LOG_ENABLED) {
        return;
    }

    if (typeof playerName !== "string") {
        return;
    }

    const trimmed = playerName.trim();
    if (!trimmed) {
        return;
    }

    const normalized = trimmed.length > 50 ? trimmed.slice(0, 50) : trimmed;
    const now = Date.now();
    const stat = playerRequestStats.get(normalized);
    if (!stat || now - stat.lastReset > PLAYER_COUNTER_WINDOW_MS) {
        playerRequestStats.set(normalized, { count: 1, lastReset: now });
        return;
    }

    stat.count += 1;
    if (stat.count % PLAYER_SPAM_THRESHOLD === 0) {
        console.warn("[PlayerSpam] High request volume from player", {
            playerName: normalized,
            count: stat.count,
            windowMs: PLAYER_COUNTER_WINDOW_MS
        });
    }
};

const ensureJobPool = async (placeId) => {
    const now = Date.now();
    const cached = jobCache.get(placeId);

    if (cached && cached.expiresAt > now) {
        ensureModeStates(cached);
        const available = countAvailableJobs(cached);
        if (available > 0) {
            const threshold = Math.max(1, Math.min(JOB_TOP_UP_THRESHOLD, JOB_POOL_TARGET));
            if (available < threshold) {
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
    const playerName = typeof req.query.playerName === "string" ? req.query.playerName : "";

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
        recordPlayerHit(playerName);

        const remaining = countAvailableJobs(entry);

        const responsePayload = {
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
        };

        if (playerName && playerName.trim()) {
            responsePayload.player = playerName.trim();
        }

        return res.json(responsePayload);
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
const scheduleModePoolTopUp = (placeId, entry, state) => {
    if (!state || state.inflight) {
        return;
    }
    if (entry.jobs.length >= JOB_POOL_TARGET || entry.expiresAt <= Date.now()) {
        return;
    }
    state.inflight = true;
    (async () => {
        try {
            await fetchModeBatch(placeId, entry, state);
        } catch (error) {
            logErrorThrottled(
                `jobpool-topup-failed-${placeId}-${state.mode?.sortOrder ?? "Asc"}`,
                `Job pool top-up failed for place ${placeId}`,
                { error: error instanceof Error ? error.message : String(error) }
            );
        } finally {
            state.inflight = false;
        }
    })();
};

const fetchModeBatch = async (placeId, entry, state, target = null) => {
    const modeCount = entry.modeStates.size || 1;
    const perModePages = Math.max(1, Math.floor(JOB_FETCH_MAX_PAGES / modeCount));
    let pages = 0;
    let added = 0;
    const seenJobIds = new Set(entry.jobIds);
    const desired = target ?? Math.max(1, Math.ceil(JOB_POOL_TARGET / modeCount));

    while (pages < perModePages && (JOB_ALWAYS_SCRAPE || entry.jobs.length < JOB_POOL_TARGET) && added < desired) {
        const payload = await requestRobloxServerPage(placeId, state.cursor ?? undefined, state.mode);
        pages += 1;

        if (!Array.isArray(payload?.data)) {
            logErrorThrottled(
                "roblox-empty-data",
                "[Roblox] Server payload missing data array",
                {
                    placeId,
                    mode: state.mode,
                    payload: payload && typeof payload === "object" ? Object.keys(payload) : typeof payload
                }
            );
            throw new Error("Roblox response did not include server data");
        }

        const rawServers = payload.data;
        const { filtered, stats } = filterServerRecords(rawServers, seenJobIds, state.mode);
        if (filtered.length) {
            const jobs = shuffle(filtered.map(buildJobRecord));
            added += appendJobsToEntry(entry, jobs);
        } else {
            console.warn(`[JobPool] Roblox page yielded zero eligible servers`, {
                placeId,
                stats,
                mode: state.mode
            });
        }

        state.cursor = payload?.nextPageCursor ?? null;
        if (!state.cursor) {
            break;
        }
    }
};

const primeModePool = async (placeId, entry, state) => {
    const perModeDesired = Math.max(1, Math.ceil(JOB_POOL_TARGET / (entry.modeStates.size || 1)));
    const primeTarget = Math.min(perModeDesired, JOB_PRIME_BATCH_SIZE);
    await fetchModeBatch(placeId, entry, state, primeTarget);
};
