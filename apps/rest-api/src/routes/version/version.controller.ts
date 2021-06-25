import { Controller, Get, Inject } from '@nestjs/common';
import { VersionService } from '@pct-org/types/version'

@Controller('version')
export class VersionController {

  @Inject()
  private readonly versionService: VersionService

  @Get('/latest')
  public async latest() {
      return await this.versionService.fetchLatestVersion();
  }

}
