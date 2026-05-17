# FileFlow — Event-Driven File Processing Pipeline

A hands-on example of **event-driven architecture** using AWS SNS, SQS, S3, and DynamoDB — all running locally via [Floci](https://floci.io), a free open-source AWS emulator.

Upload a file through the web UI and watch four independent worker services process it in parallel, with results persisted in DynamoDB and reflected live in the UI.

---

## Architecture

### Current Implementation (Polling)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                  │
│                                                                           │
│  1. POST /api/upload                                                      │
│  2. receives { fileId }                                                   │
│  3. polls GET /api/status/:fileId every 2s until complete                │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ POST /api/upload
                             ▼
              ┌──────────────────────────┐
              │     API Service :3000    │
              │                          │
              │  1. store file ──────────────────────────► S3
              │  2. init status ─────────────────────────► DynamoDB
              │     (#meta row + 4x pending processor rows)
              │  3. publish event ───────────────────────► SNS (file-events)
              │  4. return { fileId } ───────────────────► Browser
              │                          │
              │  GET /api/status/:fileId │
              │  queries DynamoDB ◄──────────────────────── Browser polling
              └──────────────────────────┘
                             │
                             │ SNS fan-out — one event → 4 queues simultaneously
                             │
              ┌──────────────┼───────────────────────────┐
              ▼              ▼              ▼             ▼
   queue-virus-scanner  queue-thumbnail  queue-metadata  queue-optimizer
              │              │              │             │
              ▼              ▼              ▼             ▼
       virus-scanner   thumbnail-gen  metadata-indexer  storage-optimizer
              │              │              │             │
              │  each worker writes result row directly to DynamoDB
              └──────────────┴──────────────┴─────────────┘
                                      │
                                      ▼
                                  DynamoDB
                             (file-processing table)
                                      │
                             API reads on demand
                             per polling request
                                      │
                                      ▼
                                   Browser
```

---

### Improved Architecture (WebSocket + Redis — at scale)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                  │
│                                                                           │
│  1. POST /api/upload                                                      │
│  2. receives { fileId }                                                   │
│  3. GET /api/status/:fileId immediately (catch whatever is already done) │
│  4. if complete → done, no WebSocket needed                              │
│  5. if still processing → open WebSocket → send { fileId }              │
│  6. receive pushes as remaining workers finish                           │
│  7. close WebSocket when overallStatus = complete                        │
└──────┬──────────────────────────────┬──────────────────┬────────────────┘
       │ POST /api/upload             │ GET /status      │ WebSocket connect
       │                              │ (catch up first) │ (then watch remaining)
       ▼                                          ▼
┌──────────────────────────────────────────────────────┐
│                  API Service :3000                    │
│                                                       │
│  On upload:                                           │
│    1. store file ──────────────────────────► S3       │
│    2. init status ─────────────────────────► DynamoDB │
│       (#meta + 4x pending rows)                       │
│    3. publish event ───────────────────────► SNS      │
│    4. return { fileId }                               │
│                                                       │
│  On WebSocket connect:                                │
│    5. register fileId → localWatchers Map             │
│    6. subscribe to Redis channel "file:{fileId}"      │
│                                                       │
│  On Redis message:                                    │
│    7. push update to browser via WebSocket            │
│                                                       │
│  On GET /api/status/:fileId:                          │
│    8. query DynamoDB → return current state           │
└──────────────────────────────────────────────────────┘
       │ SNS fan-out                      ▲ Redis pub/sub delivers
       │                                  │ to subscribed server
       ├──────────────┬───────────────────┼──────────────┐
       ▼              ▼              ▼    │              ▼
  queue-virus    queue-thumb    queue-meta│         queue-optimizer
       │              │              │   │               │
       ▼              ▼              ▼   │               ▼
  virus-scanner  thumbnail-gen  metadata-│        storage-optimizer
       │              │          indexer │               │
       │   each worker:                  │               │
       │   1. write result ─────────────────────────► DynamoDB
       │   2. publish to Redis ──────────┘ ("file:{fileId}" channel)
       └──────────────┴──────────────────┴───────────────┘
                                    │
                              ┌─────┴──────┐
                              │   Redis    │ delivers to all
                              │  Pub/Sub   │ subscribed servers
                              └─────┬──────┘
                                    │
                              API pushes via WebSocket
                                    │
                                    ▼
                                 Browser
                          (chip updates instantly
                           as each worker finishes)
```

---

## Why DynamoDB instead of a results queue

An earlier version of this system used a shared `queue-processing-results` SQS queue — workers published results there, and the API polled it continuously to update an in-memory status store.

This was replaced with DynamoDB for three reasons:

| Problem (queue approach) | Solution (DynamoDB) |
|---|---|
| API restart wipes all status (in-memory) | DynamoDB persists forever |
| Multiple API instances have inconsistent state | All instances read the same DB |
| Single queue becomes a bottleneck at scale | Each file is independent rows |
| Can't look up old files after memory clears | DynamoDB queryable anytime |

Workers now write results **directly** to DynamoDB. The API queries DynamoDB **on demand** per request. No polling loop. No in-memory state.

---

## DynamoDB Table Design — Single Table

One table (`file-processing`) stores both file metadata and all processor statuses, separated by sort key:

```
fileId      | processor (SK)      | fields
────────────────────────────────────────────────────────────────
abc-123     | #meta               | fileName, mimeType, fileSize, uploadedAt
abc-123     | virusScanner        | status, result, processedAt
abc-123     | thumbnailGenerator  | status, result, processedAt
abc-123     | metadataIndexer     | status, result, processedAt
abc-123     | storageOptimizer    | status, result, processedAt
```

One DynamoDB query by `fileId` returns all 5 rows — file info and all processor statuses in a single network hop. This is the **single table design** pattern: data that is always queried together lives under the same partition key.

---

## AWS Resources

| Resource | Name | Purpose |
|---|---|---|
| S3 Bucket | `file-uploads` | Raw file storage |
| SNS Topic | `file-events` | Event bus — fans out `FileUploaded` to all queues |
| SQS Queue | `queue-virus-scanner` | Delivers events to virus scanner worker |
| SQS Queue | `queue-thumbnail-generator` | Delivers events to thumbnail generator worker |
| SQS Queue | `queue-metadata-indexer` | Delivers events to metadata indexer worker |
| SQS Queue | `queue-storage-optimizer` | Delivers events to storage optimizer worker |
| DynamoDB Table | `file-processing` | Persistent status store — replaces results queue |

---

## Services

### API (`services/api`)
- `POST /api/upload` — receives file, stores in S3, writes pending status rows to DynamoDB, publishes `FileUploaded` event to SNS
- `GET /api/status/:fileId` — queries DynamoDB and returns current status of all processors
- No background polling loop — status is read directly from DynamoDB per request

### Virus Scanner (`services/virus-scanner`)
- Polls `queue-virus-scanner`
- Simulates AV scan (1–3s delay, 5% threat detection rate)
- Writes result directly to DynamoDB: `{ clean, engine, scanDurationMs, threatsFound }`

### Thumbnail Generator (`services/thumbnail-generator`)
- Polls `queue-thumbnail-generator`
- Generates thumbnail metadata for images/videos; placeholder for other types
- Writes result directly to DynamoDB: `{ generated, thumbnailKey, dimensions, format }`

### Metadata Indexer (`services/metadata-indexer`)
- Polls `queue-metadata-indexer`
- Derives category, tags, searchable text from filename and MIME type
- Writes result directly to DynamoDB: `{ category, tags, sizeHuman, searchableText }`

### Storage Optimizer (`services/storage-optimizer`)
- Polls `queue-storage-optimizer`
- Skips already-compressed types (JPEG, MP4, ZIP…); simulates Brotli for others
- Writes result directly to DynamoDB: `{ optimized, algorithm, compressionRatio, savedBytes }`

---

## Event Schema

### `FileUploaded` — API → SNS → 4 SQS queues

```json
{
  "eventType": "FileUploaded",
  "fileId": "uuid-v4",
  "fileName": "report.pdf",
  "fileKey": "uploads/<fileId>/report.pdf",
  "fileSize": 204800,
  "mimeType": "application/pdf",
  "uploadedAt": "2026-05-17T10:00:00.000Z"
}
```

> **SNS envelope:** When SNS delivers to SQS the message is wrapped.
> Workers unwrap it with: `JSON.parse(JSON.parse(sqsMessage.Body).Message)`

---

## Startup Order

Docker Compose enforces strict startup ordering to prevent race conditions:

```
1. floci starts          (AWS emulator)
2. setup runs            (creates all AWS resources, exits 0)
3. api + workers start   (only after setup completes successfully)
```

Workers use `depends_on: setup: condition: service_completed_successfully` — they will not start until the setup container exits cleanly. This guarantees all SQS queues, the SNS topic, the S3 bucket, and the DynamoDB table exist before any service tries to use them.

---

## Getting Started

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

### First run

```bash
docker compose up --build
```

### Reset everything (wipe Floci data, recreate all resources)

```bash
docker compose down -v && docker compose up --build
```

Open **http://localhost:3000**, drop any file, and watch all four processors run in parallel.

---

## Project Structure

```
microservicant/
├── docker-compose.yml           # Orchestrates all 6 containers with strict ordering
├── scripts/
│   └── setup-infra.mjs          # Creates S3, SNS, SQS, DynamoDB on startup
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js                   # Upload, polling, live status rendering
└── services/
    ├── api/
    │   └── src/
    │       ├── index.ts
    │       ├── lib/
    │       │   ├── aws.ts           # AWS SDK clients (S3, SNS, SQS, DynamoDB)
    │       │   ├── types.ts         # Shared event and status types
    │       │   └── statusStore.ts   # DynamoDB read/write (replaces in-memory Map)
    │       └── routes/
    │           ├── upload.ts        # POST /api/upload
    │           └── status.ts        # GET /api/status/:fileId
    ├── virus-scanner/
    ├── thumbnail-generator/
    ├── metadata-indexer/
    └── storage-optimizer/
        └── src/index.ts            # poll SQS → process → write to DynamoDB
```

---

## Key Concepts Demonstrated

| Concept | Where |
|---|---|
| **Event publishing** | API publishes `FileUploaded` to SNS after S3 upload |
| **Fan-out** | SNS delivers one event to 4 independent SQS queues simultaneously |
| **Decoupled consumers** | Each worker is fully independent — adding a 5th processor requires zero changes to the API or other workers |
| **At-least-once delivery** | SQS messages deleted only after successful processing — if worker crashes, message reappears after visibility timeout |
| **Direct state writes** | Workers write to DynamoDB directly — no results queue, no API middleman |
| **Single table design** | One DynamoDB table stores file metadata and all processor statuses under the same partition key — one query returns everything |
| **Startup ordering** | `service_completed_successfully` ensures infrastructure exists before services start |
| **Long polling** | `WaitTimeSeconds=5` reduces unnecessary SQS API calls |

---

## Extending This System

**Add a new processor in 4 steps:**

1. Create `services/my-processor/` following the same pattern as existing workers
2. Add `queue-my-processor` to `scripts/setup-infra.mjs` and subscribe it to `file-events`
3. Add the service to `docker-compose.yml` with its `QUEUE_URL`
4. Add the processor name to `statusStore.ts` and the frontend processor list

Zero changes needed to the API, SNS topic, or any other worker. This is the core power of event-driven architecture — producers and consumers are fully independent.

---

## Production Considerations

This system uses simulated processing (mocked results). To make it production-ready:

| Worker | Replace mock with |
|---|---|
| Virus Scanner | ClamAV SDK or cloud AV API |
| Thumbnail Generator | Sharp (images), FFmpeg (video) |
| Metadata Indexer | Apache Tika or cloud vision API |
| Storage Optimizer | Node.js `zlib` (Brotli/gzip) |

---

## Improvements & Scaling

### 1. Real-Time Updates — WebSocket + Redis Pub/Sub

The current system uses **browser polling** — the frontend asks `GET /api/status/:fileId` every 2 seconds. This works but has two problems:

- Up to 2 second delay between a worker finishing and the UI updating
- Constant unnecessary requests even when nothing has changed

**The improvement:** Replace polling with WebSocket for instant push updates.

```
Current (polling):
  worker finishes → writes DynamoDB → browser polls 2s later → UI updates

Improved (WebSocket):
  worker finishes → writes DynamoDB → pushes instantly → UI updates immediately
```

#### Why this breaks at multiple API servers

A single WebSocket connection is tied to one server instance. When you scale the API to multiple instances:

```
Browser connects WebSocket to Server 1
Worker finishes, happens to notify Server 2
Server 2 has no record of this browser connection
Browser never receives the update ❌
```

Each server only knows about browsers connected to itself — there is no shared knowledge across instances.

#### The fix — Redis Pub/Sub as the cross-server bridge

Redis Pub/Sub acts as a shared message channel all servers subscribe to:

```
Browser ──WebSocket──► Server 1
                         │ subscribe "file:abc-123"
                         ▼
                       Redis
                         ▲
Worker finishes          │ publish "file:abc-123" { processor, status }
  → write DynamoDB       │
  → redis.publish ───────┘

Redis delivers to all subscribers:
  → Server 1 receives it (subscribed to "file:abc-123")
  → Server 1 pushes to Browser via WebSocket ✅
```

#### How it works in code

```
Browser side (one connection per file upload):
  const ws = new WebSocket('ws://api:3000')
  ws.send(JSON.stringify({ fileId }))        // tell server which file to watch
  ws.onmessage = (e) => updateUI(e.data)     // update chip when pushed

Server side (runs on every API instance):
  const localWatchers = new Map()            // fileId → WebSocket (this server only)
  const redisSub = new Redis()               // one connection per server for subscribing

  // when browser connects
  localWatchers.set(fileId, ws)
  redisSub.subscribe(`file:${fileId}`)       // tell Redis to notify this server

  // when Redis delivers a message
  redisSub.on('message', (channel, msg) => {
    const ws = localWatchers.get(fileId)
    if (ws) ws.send(msg)                     // push to browser
  })

Worker side (after writing to DynamoDB):
  redis.publish(`file:${fileId}`, JSON.stringify({ processor, status, result }))
```

#### The complete scaled flow

```
1.  Browser uploads file → gets fileId
2.  Browser opens WebSocket → sends { fileId }
3.  Server 1 subscribes to Redis channel "file:abc-123"

4.  Worker finishes on any server
5.  Worker writes result to DynamoDB        (persistent state)
6.  Worker publishes to Redis "file:abc-123" (real-time notification)

7.  Redis delivers to Server 1 (subscribed)
8.  Server 1 pushes update to Browser via WebSocket
9.  Browser updates that processor chip instantly

10. All 4 workers done → Browser closes WebSocket
11. Server 1 unsubscribes from Redis "file:abc-123"
```

#### Why both DynamoDB and Redis are needed

```
DynamoDB alone:
  persistent ✅ but browser must poll → delay ❌

Redis alone:
  instant ✅ but ephemeral — if browser disconnects and reconnects it misses everything ❌

Together:
  worker finishes
    → DynamoDB  permanent record, queryable anytime, survives restarts ✅
    → Redis     instant notification, zero delay ✅

  browser reconnects after drop?
    → GET /api/status/:fileId reads DynamoDB to catch up ✅
    → re-subscribes WebSocket for remaining live updates ✅
```

---

### 2. Status Page — Show Previous Uploads

Currently the UI only shows files uploaded in the current browser session. If you refresh the page, the history is gone from the frontend (though DynamoDB still has the data).

**The improvement:** Add a `GET /api/files` endpoint backed by a DynamoDB GSI (Global Secondary Index) that lists all recent uploads, so the status page loads previous files on refresh.

---

### 3. Dead Letter Queues (DLQ)

If a worker crashes repeatedly while processing a message, SQS will keep redelivering it — potentially forever. A Dead Letter Queue captures messages that fail after a configured number of attempts.

```
queue-virus-scanner
  maxReceiveCount: 3        if message fails 3 times
        │
        ▼
queue-virus-scanner-dlq     message moved here for inspection
```

This prevents poison pill messages (malformed events that always crash the worker) from blocking the queue indefinitely.

---

### 4. Replace SNS + SQS with Kafka (at org scale)

The current SNS + SQS fan-out requires someone to create and manage a dedicated queue for every new consumer. Adding a 5th processor means:

1. Create a new SQS queue
2. Subscribe it to the SNS topic
3. Deploy infrastructure changes

With **Apache Kafka (or AWS MSK)**, any new consumer simply creates a consumer group and starts reading the `file-events` topic independently — no infrastructure changes, no coordination with other teams:

```
SNS + SQS (current):          Kafka (at scale):
  1 SNS topic                   1 Kafka topic: file-events
  4 SQS queues (one per worker) 4 consumer groups (one per worker)
  new worker = new queue        new worker = new consumer group
             = infra change               = just config, no infra change
```

Kafka also enables **event replay** — if a new processor is added later, it can rewind and reprocess all historical file upload events without any re-uploads.

Use Kafka when:
- Multiple teams need to independently consume the same events
- You need to replay historical events
- Message volume exceeds what SQS handles comfortably
