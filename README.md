# FileFlow — Event-Driven File Processing Pipeline

A hands-on example of **event-driven architecture** using AWS SQS, SNS, and S3 — all running locally via [Floci](https://floci.io), a free AWS emulator.

Upload a file through the web UI and watch four independent worker services process it in parallel, each reporting results back in real time.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                      │
│  POST /api/upload ──► GET /api/status/:fileId (polling)      │
└───────────┬─────────────────────────────────────────────────-┘
            │
            ▼
┌───────────────────┐
│   API Service     │  Express + TypeScript
│   :3000           │
│                   │
│  1. Upload file ──────────────► S3 bucket (file-uploads)
│  2. Publish event ────────────► SNS topic (file-events)
│  3. Poll results ◄──────────── SQS (queue-processing-results)
│  4. Update status store        (in-memory Map)
└───────────────────┘
            │
            │  SNS fan-out (one message → 4 queues simultaneously)
            │
     ┌──────┴──────────────────────────────────┐
     │              │              │             │
     ▼              ▼              ▼             ▼
┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│  Virus  │  │Thumbnail │  │Metadata  │  │ Storage  │
│ Scanner │  │Generator │  │ Indexer  │  │Optimizer │
└────┬────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │              │              │
     └─────────────┴──────────────┴──────────────┘
                            │
                            ▼
              SQS: queue-processing-results
                            │
                            ▼
                    API updates status store
```

### AWS Resources (created on startup)

| Resource | Name | Purpose |
|---|---|---|
| S3 Bucket | `file-uploads` | Raw file storage |
| SNS Topic | `file-events` | Event bus — publishes `FileUploaded` |
| SQS Queue | `queue-virus-scanner` | Delivers events to virus scanner |
| SQS Queue | `queue-thumbnail-generator` | Delivers events to thumbnail generator |
| SQS Queue | `queue-metadata-indexer` | Delivers events to metadata indexer |
| SQS Queue | `queue-storage-optimizer` | Delivers events to storage optimizer |
| SQS Queue | `queue-processing-results` | Workers publish results here; API consumes |

---

## Services

### API (`services/api`)
- Accepts file uploads via `POST /api/upload`
- Stores the raw file in S3
- Publishes a `FileUploaded` event to the SNS topic
- Continuously polls `queue-processing-results` and updates the in-memory status store
- Serves the frontend and status via `GET /api/status/:fileId`

### Virus Scanner (`services/virus-scanner`)
- Polls `queue-virus-scanner`
- Simulates AV scanning (1–3 s delay, 5% threat detection rate)
- Result: `{ clean, engine, scanDurationMs, threatsFound }`

### Thumbnail Generator (`services/thumbnail-generator`)
- Polls `queue-thumbnail-generator`
- Generates metadata for image/video thumbnails; falls back to a type-icon placeholder
- Result: `{ generated, thumbnailKey, dimensions, format }`

### Metadata Indexer (`services/metadata-indexer`)
- Polls `queue-metadata-indexer`
- Derives category, tags, and searchable text from filename and MIME type
- Result: `{ category, tags, sizeHuman, searchableText }`

### Storage Optimizer (`services/storage-optimizer`)
- Polls `queue-storage-optimizer`
- Skips already-compressed types (JPEG, MP4, ZIP, …); otherwise simulates Brotli compression
- Result: `{ optimized, algorithm, compressionRatio, savedBytes }`

---

## Event Schema

### `FileUploaded` (API → SNS → 4 SQS queues)
```json
{
  "eventType": "FileUploaded",
  "fileId": "uuid-v4",
  "fileName": "report.pdf",
  "fileKey": "uploads/<fileId>/report.pdf",
  "fileSize": 204800,
  "mimeType": "application/pdf",
  "uploadedAt": "2026-05-16T10:00:00.000Z"
}
```

### `ProcessingResult` (workers → queue-processing-results)
```json
{
  "eventType": "ProcessingResult",
  "fileId": "uuid-v4",
  "processor": "virusScanner",
  "status": "success",
  "result": { "clean": true, "engine": "MockAV v3.1", "scanDurationMs": 1423 },
  "processedAt": "2026-05-16T10:00:02.000Z"
}
```

> **SNS envelope:** When SNS delivers to SQS the message is wrapped in an envelope.
> Workers unwrap it with: `JSON.parse(JSON.parse(sqsMessage.Body).Message)`

---

## Getting Started

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

### Run

```bash
docker compose up --build
```

That's it. Docker Compose will:
1. Start **Floci** (AWS emulator on port 4566)
2. Run the **setup** container which creates S3, SNS, SQS resources
3. Start the **API** and all four **worker** services
4. Serve the UI at **http://localhost:3000**

### First upload

1. Open **http://localhost:3000**
2. Drop any file onto the upload area
3. Watch all four processors run in parallel and report results live

---

## Project Structure

```
microservicant/
├── docker-compose.yml          # Orchestrates all 7 containers
├── scripts/
│   └── setup-infra.mjs         # Creates S3 bucket, SNS topic, SQS queues
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js                  # Upload, polling, and live status rendering
└── services/
    ├── api/                    # Express API + results consumer
    │   └── src/
    │       ├── index.ts
    │       ├── lib/
    │       │   ├── aws.ts          # AWS SDK clients (S3, SNS, SQS)
    │       │   ├── types.ts        # Shared event types
    │       │   ├── statusStore.ts  # In-memory file status tracker
    │       │   └── resultsConsumer.ts  # Polls queue-processing-results
    │       └── routes/
    │           ├── upload.ts       # POST /api/upload
    │           └── status.ts       # GET /api/status/:fileId
    ├── virus-scanner/
    ├── thumbnail-generator/
    ├── metadata-indexer/
    └── storage-optimizer/
```

---

## Key Event-Driven Concepts Demonstrated

| Concept | Where |
|---|---|
| **Event publishing** | API publishes `FileUploaded` to SNS after S3 upload |
| **Fan-out** | SNS delivers one event to 4 independent SQS queues simultaneously |
| **Decoupled consumers** | Each worker is fully independent — adding a 5th processor requires zero API changes |
| **At-least-once delivery** | SQS messages are only deleted after successful processing |
| **Result aggregation** | A shared results queue collects all processor outputs |
| **Polling consumer** | Long-polling (WaitTimeSeconds=5) reduces unnecessary SQS requests |
| **Idempotent design** | Each processor handles one event type, publishes one result type |

---

## Extending This System

**Add a new processor:**
1. Create `services/my-processor/` with the same pattern as existing workers
2. Add a new queue `queue-my-processor` in `scripts/setup-infra.mjs`
3. Subscribe it to the `file-events` SNS topic
4. Add the service to `docker-compose.yml`
5. Add the processor name to the status store and frontend — **no changes to the API or other workers**

This is the core power of event-driven architecture: producers and consumers are fully independent.
