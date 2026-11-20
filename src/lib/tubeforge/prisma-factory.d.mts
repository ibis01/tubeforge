// Type surface for prisma-factory.mjs (plain ESM shared by the app and the
// operator scripts — see the .mjs for the adapter-selection law).
import type { PrismaClient } from "@prisma/client";

export declare function createPrismaAdapter(
  url?: string,
): unknown;

export declare function createPrisma(
  options?: ConstructorParameters<typeof PrismaClient>[0],
): PrismaClient;
