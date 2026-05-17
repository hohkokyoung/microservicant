import { S3Client } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const config = {
  endpoint: process.env.AWS_ENDPOINT_URL || 'http://localhost:4566',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
  forcePathStyle: true,
};

export const s3  = new S3Client(config);
export const sns = new SNSClient(config);
export const sqs = new SQSClient(config);

// DynamoDBDocumentClient handles marshalling/unmarshalling JS types automatically
// so we work with plain JS objects instead of { S: 'value' } DynamoDB syntax
const rawDdb = new DynamoDBClient(config);
export const ddb = DynamoDBDocumentClient.from(rawDdb);

export const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'file-processing';
