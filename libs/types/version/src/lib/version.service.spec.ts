import { Test } from '@nestjs/testing';
import { VersionService } from './version.service';

describe('TypesVersionService', () => {
  let service: VersionService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [VersionService],
    }).compile();

    service = module.get(VersionService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
