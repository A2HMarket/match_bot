import type { Approval, PrismaClient } from '../generated/client.js';

export function approvalsRepo(prisma: PrismaClient) {
  return {
    create(p: {
      runStateId: string;
      reviewer: string;
      decision: 'approve' | 'reject' | 'edit' | 'ignore';
      editedText?: string;
    }): Promise<Approval> {
      return prisma.approval.create({ data: p });
    },
    findById(id: string): Promise<Approval | null> {
      return prisma.approval.findUnique({ where: { id } });
    },
  };
}
