export interface ScoredCandidate {
  id: string;
  kind: 'supplier' | 'supply';
  score: number;
  reasons: string[];
}
