export interface Torrents {

  en: {
    [key: string]: {
      url: string
      seed: number
      peer: number
      size: number
      filesize: string
      provider: string
    },
  }

}
