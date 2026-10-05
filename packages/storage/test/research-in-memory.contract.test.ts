import { describeResearchRepository } from './research-repository-contract';
import { InMemoryResearchRepository } from '../src/research-in-memory';

describeResearchRepository('InMemoryResearchRepository', () => new InMemoryResearchRepository());
