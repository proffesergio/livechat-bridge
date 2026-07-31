/**
 * Shared in-memory MongoDB harness.
 *
 * The mongod binary is cached under `node_modules/.cache/mongodb-memory-server`,
 * so pinning the version keeps the suite from reaching for the network to
 * resolve "latest".
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { connectDb, disconnectDb } from '../src/server/db.js';

const MONGOD_VERSION = '8.2.6';

let server: MongoMemoryServer | null = null;

export async function startMongo(): Promise<string> {
  server = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
  const uri = server.getUri();
  await connectDb(uri);
  return uri;
}

export async function stopMongo(): Promise<void> {
  await disconnectDb();
  if (server) await server.stop();
  server = null;
}

export async function clearDb(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}
