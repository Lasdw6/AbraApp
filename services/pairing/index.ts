import { DynamoDBClient, DeleteItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { createHandler, type Store } from './handler.js';
const client = new DynamoDBClient({});
const TableName = process.env.TABLE_NAME!;
const conditionalFailure = (error: unknown) => error instanceof Error && error.name === 'ConditionalCheckFailedException';
const store: Store = {
  async limit(key, maximum, expiresAt) {
    try {
      await client.send(new UpdateItemCommand({ TableName, Key: { id: { S: key } }, UpdateExpression: 'SET expiresAt = :expiry ADD requests :one', ConditionExpression: 'attribute_not_exists(requests) OR requests < :maximum', ExpressionAttributeValues: { ':expiry': { N: String(expiresAt) }, ':one': { N: '1' }, ':maximum': { N: String(maximum) } } }));
      return true;
    } catch (error) { if (conditionalFailure(error)) return false; throw error; }
  },
  async put(ticket) {
    try {
      await client.send(new PutItemCommand({ TableName, Item: { id: { S: ticket.id }, ...(ticket.ticket ? { ticket: { S: ticket.ticket } } : { ciphertext: { S: ticket.ciphertext! } }), expiresAt: { N: String(ticket.expiresAt) } }, ConditionExpression: 'attribute_not_exists(id)' }));
      return true;
    } catch (error) { if (conditionalFailure(error)) return false; throw error; }
  },
  async take(id, now, field) {
    try {
      const result = await client.send(new DeleteItemCommand({ TableName, Key: { id: { S: id } }, ConditionExpression: 'expiresAt > :now AND attribute_exists(#payload)', ExpressionAttributeNames: { '#payload': field }, ExpressionAttributeValues: { ':now': { N: String(now) } }, ReturnValues: 'ALL_OLD' }));
      return { id, [field]: result.Attributes![field].S!, expiresAt: Number(result.Attributes!.expiresAt.N) };
    } catch (error) { if (conditionalFailure(error)) return null; throw error; }
  },
};
export const handler = createHandler(store);
