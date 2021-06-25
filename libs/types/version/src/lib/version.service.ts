import { Injectable } from '@nestjs/common';
import { Version } from './version.object-type';

@Injectable()
export class VersionService {

  public async fetchLatestVersion(): Promise<Version> {
    return new Version("1.0.0");
  }
}
