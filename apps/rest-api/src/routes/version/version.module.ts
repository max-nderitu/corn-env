import { HttpModule, Module } from '@nestjs/common'
import { VersionService } from '@pct-org/types/version'

import { VersionController } from './version.controller'

@Module({
  imports: [
    HttpModule
  ],
  providers: [
    VersionService
  ],
  controllers: [
    VersionController
  ]
})
export class VersionModule {
}
