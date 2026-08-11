import axios from 'axios';
import { redis } from '../lib/redis';
import { config } from '../config';
import { logger } from '../lib/logger';

export const contextService = {

  async buildContext(
    lat: number,
    lon: number,
    opts: { occasion?: string; occupation?: string; culturalCtx?: string } = {},
  ) {
    // Cache key rounded to ~11km grid — good enough for climate/culture
    // Include all context dimensions to avoid collisions
    const cacheKey = `ctx:${lat.toFixed(1)}:${lon.toFixed(1)}:${opts.occasion ?? ''}:${opts.occupation ?? ''}:${opts.culturalCtx ?? ''}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // Redis unavailable — proceed without cache
    }

    // 1. Weather
    let climateData: Record<string, unknown> = { temp: 22, condition: 'clear', description: 'Mild' };

    if (config.openweather.apiKey) {
      try {
        const res = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
          params: { lat, lon, appid: config.openweather.apiKey, units: 'metric' },
          timeout: 5_000,
        });
        climateData = {
          temp:        Math.round(res.data.main.temp),
          feelsLike:   Math.round(res.data.main.feels_like),
          condition:   res.data.weather[0].main.toLowerCase(),
          description: res.data.weather[0].description,
          humidity:    res.data.main.humidity,
        };
      } catch {
        logger.warn('OpenWeather unavailable — using climate defaults');
      }
    }

    // 2. Style constraints from AI context inference service
    let constraints: Record<string, unknown> = {};
    try {
      const { data } = await axios.post(
        `${config.ai.contextInference}/infer`,
        {
          temperature_c: (climateData.temp as number),
          condition:     climateData.condition,
          lat,
          lon,
          region:     opts.culturalCtx,
          occasion:   opts.occasion   ?? 'casual',
          occupation: opts.occupation ?? 'general',
        },
        { timeout: 5_000 },
      );
      constraints = data.constraints ?? {};
    } catch {
      logger.warn('Context inference unavailable — using empty constraints');
    }

    const context = {
      climate:     climateData,
      occasion:    opts.occasion   ?? 'casual',
      occupation:  opts.occupation ?? 'general',
      culturalCtx: opts.culturalCtx ?? 'global',
      constraints,
      generatedAt: new Date().toISOString(),
    };

    try {
      await redis.setex(cacheKey, 3600, JSON.stringify(context));
    } catch {
      // non-fatal
    }
    return context;
  },
};
