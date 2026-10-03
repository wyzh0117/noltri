import { describeKnowledgeRepository } from './repository-contract';
import { InMemoryRepository } from '../src/in-memory';

describeKnowledgeRepository('InMemoryRepository', () => new InMemoryRepository());
