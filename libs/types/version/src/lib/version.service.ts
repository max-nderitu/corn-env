import { HttpService, Inject, Injectable } from '@nestjs/common';
import { map } from 'rxjs/operators';
import { Version } from './version.object-type';

@Injectable()
export class VersionService {
  @Inject()
  private httpService: HttpService

  public async fetchLatestVersion() {
    return this.httpService.get("https://storage.googleapis.com/series-torrentor-app/latest-version")
      .pipe(
        map(res => new Version(res.data.replace(/[\n\r]/g, '')))
      );
  }
}
