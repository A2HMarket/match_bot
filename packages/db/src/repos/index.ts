import type { PrismaClient } from '../generated/client.js';
import { approvalsRepo } from './approvals.js';
import { demandsRepo } from './demands.js';
import { groupsRepo } from './groups.js';
import { leadsRepo } from './leads.js';
import { matchesRepo } from './matches.js';
import { messagesRepo } from './messages.js';
import { outboundRepo } from './outbound.js';
import { runStatesRepo } from './run-states.js';
import { sessionItemsRepo } from './session-items.js';
import { suppliersRepo } from './suppliers.js';
import { suppliesRepo } from './supplies.js';
import { tracesRepo } from './traces.js';
import { usersRepo } from './users.js';
import { tasksRepo } from './tasks.js';

export function createRepositories(prisma: PrismaClient) {
  return {
    users: usersRepo(prisma),
    tasks: tasksRepo(prisma),
    groups: groupsRepo(prisma),
    messages: messagesRepo(prisma),
    demands: demandsRepo(prisma),
    supplies: suppliesRepo(prisma),
    suppliers: suppliersRepo(prisma),
    matches: matchesRepo(prisma),
    leads: leadsRepo(prisma),
    sessionItems: sessionItemsRepo(prisma),
    runStates: runStatesRepo(prisma),
    approvals: approvalsRepo(prisma),
    outbound: outboundRepo(prisma),
    traces: tracesRepo(prisma),
  };
}
export type Repositories = ReturnType<typeof createRepositories>;
