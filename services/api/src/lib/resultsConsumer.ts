// Removed — workers now write results directly to DynamoDB.
// The API reads status via getFileStatus() in statusStore.ts on demand.
// No polling loop needed.
export {};
