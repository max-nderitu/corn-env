import { Module } from '@nestjs/common'
import { VersionService } from '@pct-org/types/version'

import { VersionController } from './Version.controller'

@Module({
  providers: [
    VersionService
  ],
  controllers: [
    VersionController
  ]
})
export class VersionModule {
}
