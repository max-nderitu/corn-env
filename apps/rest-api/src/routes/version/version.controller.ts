import { Controller, Get, Inject } from '@nestjs/common';
import { VersionService, Version } from '@pct-org/types/version'

@Controller('version')
export class VersionController {

  @Inject()
  private readonly versionService: VersionService

  @Get('/latest')
  public async latest(): Promise<Version> {
      return await this.versionService.fetchLatestVersion();
  }

}
