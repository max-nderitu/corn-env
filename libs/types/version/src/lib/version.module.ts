import { Module, Global } from '@nestjs/common';
import { VersionService } from './version.service';

@Global()
@Module({
  controllers: [],
  providers: [VersionService],
  exports: [VersionService],
})
export class TypesVersionModule {}
