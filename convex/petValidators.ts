import { v } from 'convex/values';
export const favorite = v.union(v.literal('ball'),v.literal('collect'),v.literal('polish'),v.null());
export const needs = v.object({battery:v.number(),joy:v.number(),cleanliness:v.number()});
export const world = v.object({needs,lowPower:v.boolean(),lastUpdated:v.number(),napAnchor:v.number(),favorite,props:v.array(v.string()),revision:v.number(),habitDay:v.number()});
export const memory = v.object({id:v.string(),at:v.number(),kind:v.string(),text:v.string()});
export const state = v.object({needs,lowPower:v.boolean(),sleeping:v.boolean(),mood:v.union(v.literal('low-power'),v.literal('sleepy'),v.literal('content'),v.literal('bright')),nextNapAt:v.number(),napUntil:v.union(v.number(),v.null()),favorite,props:v.array(v.string()),revision:v.number(),serverTime:v.number(),recentMemories:v.array(memory),suggestedAction:v.string()});
export const actionResult = v.object({state,outcome:v.union(v.literal('accepted'),v.literal('full'),v.literal('cooldown'),v.literal('local')),replayed:v.boolean()});
