import type { PrismaClient } from '../generated/client.js';
import { demandsRepo } from './demands.js';
import { groupsRepo } from './groups.js';
import { leadsRepo } from './leads.js';
import { matchesRepo } from './matches.js';
import { messagesRepo } from './messages.js';
import { suppliersRepo } from './suppliers.js';
import { suppliesRepo } from './supplies.js';
import { usersRepo } from './users.js';

export function createRepositories(prisma: PrismaClient) {
  return {
    users: usersRepo(prisma),
    groups: groupsRepo(prisma),
    messages: messagesRepo(prisma),
    demands: demandsRepo(prisma),
    supplies: suppliesRepo(prisma),
    suppliers: suppliersRepo(prisma),
    matches: matchesRepo(prisma),
    leads: leadsRepo(prisma),
  };
}
export type Repositories = ReturnType<typeof createRepositories>;
