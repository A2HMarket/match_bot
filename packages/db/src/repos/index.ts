import type { PrismaClient } from '../generated/client.js';
import { groupsRepo } from './groups.js';
import { messagesRepo } from './messages.js';
import { usersRepo } from './users.js';

export function createRepositories(prisma: PrismaClient) {
  return {
    users: usersRepo(prisma),
    groups: groupsRepo(prisma),
    messages: messagesRepo(prisma),
  };
}
export type Repositories = ReturnType<typeof createRepositories>;
