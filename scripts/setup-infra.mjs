import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { SNSClient, CreateTopicCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const awsConfig = {
  endpoint: process.env.AWS_ENDPOINT_URL || 'http://localhost:4566',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
  forcePathStyle: true,
};

const s3  = new S3Client(awsConfig);
const sns = new SNSClient(awsConfig);
const sqs = new SQSClient(awsConfig);
const ddb = new DynamoDBClient(awsConfig);

async function retry(fn, retries = 10, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`  Retrying in ${delayMs}ms... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function setup() {
  console.log('Waiting for Floci to be ready...');
  await retry(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'health-check' }));
  });

  console.log('\nSetting up AWS infrastructure...\n');

  // ── S3 ──────────────────────────────────────────────────────────────────────
  await s3.send(new CreateBucketCommand({ Bucket: 'file-uploads' })).catch(() => {});
  console.log('✓ S3 bucket: file-uploads');

  // ── DynamoDB ─────────────────────────────────────────────────────────────────
  // One table, two keys:
  //   PK: fileId    (which file)
  //   SK: processor (#meta | virusScanner | thumbnailGenerator | ...)
  //
  // This lets one query fetch file metadata + all processor statuses at once.
  try {
    await ddb.send(new CreateTableCommand({
      TableName: 'file-processing',
      AttributeDefinitions: [
        { AttributeName: 'fileId',    AttributeType: 'S' },
        { AttributeName: 'processor', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'fileId',    KeyType: 'HASH'  },
        { AttributeName: 'processor', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }));
    console.log('✓ DynamoDB table: file-processing');
  } catch (err) {
    if (err.name === 'ResourceInUseException') {
      console.log('✓ DynamoDB table: file-processing (already exists)');
    } else {
      throw err;
    }
  }

  // ── SNS ──────────────────────────────────────────────────────────────────────
  const topicResult = await sns.send(new CreateTopicCommand({ Name: 'file-events' }));
  const topicArn = topicResult.TopicArn;
  console.log('✓ SNS topic: file-events');
  console.log('  ARN:', topicArn);

  // ── SQS ──────────────────────────────────────────────────────────────────────
  // One queue per processor — no results queue needed anymore (DynamoDB handles that)
  const processorQueues = [
    'queue-virus-scanner',
    'queue-thumbnail-generator',
    'queue-metadata-indexer',
    'queue-storage-optimizer',
  ];

  const queueArns = {};
  for (const name of processorQueues) {
    const result = await sqs.send(new CreateQueueCommand({ QueueName: name }));
    const attrs  = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: result.QueueUrl,
      AttributeNames: ['QueueArn'],
    }));
    queueArns[name] = attrs.Attributes.QueueArn;
    console.log(`✓ SQS queue: ${name}`);
  }

  // Subscribe each queue to the SNS topic (fan-out)
  for (const name of processorQueues) {
    await sns.send(new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: 'sqs',
      Endpoint: queueArns[name],
    }));
    console.log(`  ↳ ${name} subscribed to file-events`);
  }

  console.log('\n✅ Infrastructure ready!\n');
}

setup().catch(err => {
  console.error('\n❌ Setup failed:', err.message);
  process.exit(1);
});
