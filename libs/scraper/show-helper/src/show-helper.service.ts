import { Inject, Injectable, Logger } from '@nestjs/common'
import { BaseHelper } from '@pct-org/scraper/base-helper'
import { ShowType, ScrapedItem, ScrapedShowTorrent } from '@pct-org/scraper/base-provider'
import { InjectModel } from '@nestjs/mongoose'
import { ShowModel, SeasonModel, EpisodeModel, Show, Movie, Season, Episode } from '@pct-org/mongo-models'
import { TraktEpisode, TraktService, TraktShow } from '@pct-org/services/trakt'
import { TmdbService } from '@pct-org/services/tmdb'
import { FanartService } from '@pct-org/services/fanart'
import { TvdbService } from '@pct-org/services/tvdb'

import { SeasonHelperService } from './season-helper.service'

@Injectable()
export class ShowHelperService extends BaseHelper {

  @InjectModel('Shows')
  private readonly showModel: ShowModel

  @InjectModel('Seasons')
  private readonly seasonModel: SeasonModel

  @InjectModel('Episodes')
  private readonly episodeModel: EpisodeModel

  @Inject()
  private readonly traktService: TraktService

  @Inject()
  private readonly tmdbService: TmdbService

  @Inject()
  private readonly fanartService: FanartService

  @Inject()
  private readonly tvdbService: TvdbService

  @Inject()
  private readonly seasonHelperService: SeasonHelperService

  protected readonly logger = new Logger('ShowHelper')

  public async getItem(imdb?: string, slug?: string): Promise<Show | undefined> {
    return this.showModel.findOne({
        [imdb ? '_id' : 'slug']: imdb || slug
      },
      {},
      { lean: true }
    )
  }

  public shouldUpdateExistingItem(item: Show): boolean {
    // Shows depends more heavily on the blacklist so we
    // if we have a existing item we need to update it.
    return true
  }

  public async updateTraktInfo(item: Show): Promise<Show> {
    // Get new trakt item
    const traktItem = await this.addTraktInfo({
      title: item.title,
      imdb: item.imdbId,
      slug: item.slug
    })

    if (!traktItem) {
      return item
    }

    // Restore props that don't need to change
    traktItem.createdAt = item.createdAt
    traktItem.bookmarked = item.bookmarked
    traktItem.bookmarkedOn = item.bookmarkedOn

    return traktItem
  }

  public async addTraktInfo(item: Pick<ScrapedItem, 'imdb' | 'slug' | 'title'>): Promise<Show | undefined> {
    // We prefer the imdb id above a slug
    let idType = 'imdb'
    let idUsed = item.imdb

    if (!idUsed) {
      idType = 'slug'
      idUsed = item.slug
    }

    let traktShow = await this.traktService.getShowSummary(idUsed)

    if (!traktShow && idType === 'imdb') {
      idType = 'slug'
      idUsed = item.slug
      traktShow = await this.traktService.getShowSummary(idUsed)
    }

    if (!traktShow) {
      // Try again in 1 week
      await this.addToBlacklist(item, ShowType, '404', 1)
      return
    }

    let traktSeasons = await this.traktService.getShowSeasons(idUsed)

    if (traktSeasons.length === 0 && idType === 'imdb') {
      traktSeasons = await this.traktService.getShowSeasons(item.slug)
    }

    if (traktSeasons.length === 0) {
      this.logger.warn(`No seasons found for slug: '${item.slug}' or imdb id: '${item.imdb}'`)
    }

    const ratingPercentage = Math.round(traktShow.rating * 10)
    const traktWatchers = await this.traktService.getShowWatching(traktShow.ids.slug)
    let traktNextEpisode = null
    let traktLastEpisode = null

    if (!['ended', 'canceled'].includes(traktShow.status)) {
      traktNextEpisode = await this.traktService.getNextEpisodeForShow(traktShow.ids.slug)
      traktLastEpisode = await this.traktService.getLastEpisodeForShow(traktShow.ids.slug)
    }

    await this.addShowToBlackListIfNeeded(item, traktShow, traktNextEpisode, traktLastEpisode)

    return {
      _id: traktShow.ids.imdb,
      slug: traktShow.ids.slug,
      imdbId: traktShow.ids.imdb,
      tmdbId: traktShow.ids.tmdb,
      tvdbId: traktShow.ids.tvdb,
      title: traktShow.title,
      released: new Date(traktShow.first_aired).getTime(),
      certification: traktShow.certification,
      synopsis: traktShow.overview,
      runtime: this.formatRuntime(traktShow.runtime),
      trailer: traktShow.trailer,
      trailerId: traktShow?.trailer?.split('v=')?.reverse()?.shift() ?? null,
      rating: {
        stars: parseFloat(((ratingPercentage / 100) * 5).toFixed(2)),
        votes: traktShow.votes,
        watching: traktWatchers?.length ?? 0,
        percentage: ratingPercentage
      },
      images: {
        backdrop: BaseHelper.DefaultImageSizes,
        poster: BaseHelper.DefaultImageSizes
      },
      type: ShowType,
      genres: traktShow.genres
        ? traktShow.genres
        : ['unknown'],
      airInfo: {
        network: traktShow.network,
        country: traktShow.country,
        day: traktShow.airs.day,
        time: traktShow.airs.time,
        status: traktShow.status
      },
      seasons: [],
      numSeasons: 0,
      bookmarkedOn: null,
      bookmarked: false,
      nextEpisodeAirs: traktNextEpisode
        ? Number(new Date(traktNextEpisode.first_aired))
        : null,
      latestEpisodeAired: 0,
      createdAt: Number(new Date()),
      updatedAt: Number(new Date()),
      lastMetadataUpdate: Number(new Date()),

      _traktSeasons: traktSeasons
    }
  }

  public addImages(item: Show): Promise<Show> {
    return this.addTmdbImages(item)
      .catch((item) => this.addTvdbImages(item))
      .catch((item) => this.addFanartImages(item))
      .catch((item) => item)
  }

  public async addTorrents(item: Show, torrents: ScrapedShowTorrent[]): Promise<Show> {
    item.seasons = this.seasonHelperService.formatTraktSeasons(
      item._traktSeasons,
      torrents
    )
    item.numSeasons = item.seasons.length + 1

    item.seasons = await this.seasonHelperService.enhanceSeasons(item.seasons)

    return Promise.resolve(item)
  }

  public async addItemToDatabase(item: Show): Promise<void> {
    this.logger.log(`'${item.title}' is a new show!`)

    item.latestEpisodeAired = this.getLastEpisodeAired(item)

    const seasons = item.seasons
    delete item.seasons

    await this.showModel.create(item)
    await this.seasonHelperService.addSeasonsInDatabase(seasons)
  }

  public async updateItemInDatabase(item: Show, hadMetadataUpdate?: boolean): Promise<void> {
    this.logger.log(`'${item.title}' is a existing show!`)
    item.latestEpisodeAired = this.getLastEpisodeAired(item)
    item.updatedAt = Number(new Date())

    if (hadMetadataUpdate) {
      item.lastMetadataUpdate = Number(new Date())
    }

    const seasons = item.seasons
    delete item.seasons

    await this.showModel.findByIdAndUpdate(item._id, item)
    await this.seasonHelperService.updateSeasonsInDatabase(seasons)

    return Promise.resolve(undefined)
  }

  private async addTmdbImages(item: Show): Promise<Movie | Show> {
    item.images = await this.tmdbService.getShowImages(item)

    return this.checkImages(item)
  }

  private async addTvdbImages(item: Show): Promise<Movie | Show> {
    item.images = await this.tvdbService.getShowImages(item)

    return this.checkImages(item)
  }

  private async addFanartImages(item: Show): Promise<Movie | Show> {
    item.images = await this.fanartService.getShowImages(item)

    return this.checkImages(item)
  }

  private getLastEpisodeAired(item: Show): number {
    const today = Date.now()

    // Get the latestEpisodeAired
    let latestEpisodeAired = null
    item.seasons.forEach(({ episodes }) => {
      // Loop true all episodes
      episodes.forEach((episode) => {
        // If the firstAired is higher then that is a newer episode, it should also have been aired
        if (episode.firstAired > latestEpisodeAired && episode.firstAired < today) {
          latestEpisodeAired = episode.firstAired
        }
      })
    })

    return latestEpisodeAired
  }

  /**
   * Add's the show to the blacklist when:
   * - The show is ended
   * - The show is canceled
   * - The show has a airing episode in the future
   */
  private async addShowToBlackListIfNeeded(item: Pick<ScrapedItem, 'imdb' | 'slug' | 'title'>, show: TraktShow, nextEpisode?: TraktEpisode, lastEpisode?: TraktEpisode) {
    if (['ended', 'canceled'].includes(show.status)) {
      await this.addToBlacklist(
        item,
        ShowType,
        show.status,
        4
      )

    } else if (nextEpisode) {
      // If we have traktNextEpisode then add it to the blacklist until that item is aired
      const nextEpisodeAirs = new Date(nextEpisode.first_aired)
      let lastEpisodeAired = null

      if (lastEpisode) {
        lastEpisodeAired = new Date(lastEpisode.first_aired)
        lastEpisodeAired.setDate(lastEpisodeAired.getDate() + 1)
      }

      // We want start checking one day before
      nextEpisodeAirs.setDate(nextEpisodeAirs.getDate() - 1)

      // Double check if the item is still being aired later then now
      // And if the previous item has not aired within the last 24 hours
      if (nextEpisodeAirs.getTime() > Date.now() && (
        !lastEpisodeAired || lastEpisodeAired.getTime() < Date.now()
      )) {
        await this.addToBlacklist(
          item,
          ShowType,
          'nextEpisode',
          null,
          nextEpisodeAirs
        )
      }
    }
  }

}
