# FileFlow — Event-Driven File Processing Pipeline

A hands-on example of **event-driven architecture** using AWS SNS, SQS, S3, and DynamoDB — all running locally via [Floci](https://floci.io), a free open-source AWS emulator.

Upload a file through the web UI and watch four independent worker services process it in parallel, with results persisted in DynamoDB and reflected live in the UI.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                          │
│  POST /api/upload ──► polls GET /api/status/:fileId every 2s     │
└───────────┬──────────────────────────────────────────────────────┘
            │
            ▼
┌───────────────────────┐
│   API Service  :3000  │  Express + TypeScript
│                       │
│  1. Store file ───────────────────────────► S3 (file-uploads)
│  2. Init status ──────────────────────────► DynamoDB (pending rows)
│  3. Publish event ────────────────────────► SNS (file-events)
│  4. Query status ◄────────────────────────── DynamoDB (on demand)
└───────────────────────┘
            │
            │  SNS fan-out — one event delivered to 4 queues simultaneously
            │
     ┌──────┴────────────────────────────────────┐
     │              │               │             │
     ▼              ▼               ▼             ▼
┌─────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐
│  Virus  │  │ Thumbnail │  │ Metadata │  │ Storage  │
│ Scanner │  │ Generator │  │ Indexer  │  │Optimizer │
└────┬────┘  └─────┬─────┘  └────┬─────┘  └────┬─────┘
     │              │              │              │
     └──────────────┴──────────────┴──────────────┘
                             │
                             │  each worker writes result directly
                             ▼
                        DynamoDB
                   (file-processing table)
                             │
                             │  API queries on demand — no polling loop
                             ▼
                          Browser
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

For real-time status updates, replace browser polling with **WebSocket + Redis Pub/Sub** — workers publish to a Redis channel on completion, backend pushes to browser instantly via WebSocket.
