export interface WeaponsConfig {
  sam: {
    salvoSize: number;
    minRangeNm: number;
    maxRangeNm: number;
    speedKts: number;
    pkSalvoVsAircraft: number;
    pkPerMissileVsAscm: number;
    altitudeFt: number;
  };
  gun: {
    maxRangeNm: number;
    burstS: number;
  };
  ciws: {
    maxRangeNm: number;
    pkPerMissile: number;
    roundsPerEngagement: number;
  };
  chaff: {
    durationS: number;
  };
  ascm: {
    pHit: number;
    pHitChaff: number;
    damagePct: number;
    arrivalRadiusNm: number;
    turnRateDegPerSec: number;
  };
}

export const WEAPONS_CONFIG: WeaponsConfig = {
  sam: {
    salvoSize: 2,
    minRangeNm: 3,
    maxRangeNm: 40,
    speedKts: 1800,
    pkSalvoVsAircraft: 0.85,
    pkPerMissileVsAscm: 0.6,
    altitudeFt: 20000,
  },
  gun: {
    maxRangeNm: 9,
    burstS: 10,
  },
  ciws: {
    maxRangeNm: 1.5,
    pkPerMissile: 0.6,
    roundsPerEngagement: 100,
  },
  chaff: {
    durationS: 60,
  },
  ascm: {
    pHit: 0.8,
    pHitChaff: 0.45,
    damagePct: 40,
    arrivalRadiusNm: 0.1,
    turnRateDegPerSec: 6,
  },
};
