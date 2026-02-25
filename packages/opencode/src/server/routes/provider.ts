import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { ModelsDev } from "../../provider/models"
import { ProviderAuth } from "../../provider/auth"
import { Auth } from "../../auth"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: ModelsDev.Provider.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const allProviders = await ModelsDev.get()
        const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }

        const connected = await Provider.list()
        const providers = Object.assign(
          mapValues(filteredProviders, (x) => Provider.fromModelsDevProvider(x)),
          connected,
        )
        return c.json({
          all: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          connected: Object.keys(connected),
        })
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ProviderAuth.methods())
      },
    )
    .get(
      "/auth/list/:providerID",
      describeRoute({
        summary: "List auth entries",
        description: "List all authentication entries for a provider, including indexed multi-account entries.",
        operationId: "provider.auth.list",
        responses: {
          200: {
            description: "Auth entries for provider",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      key: z.string(),
                      type: z.string(),
                      label: z.string(),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      async (c) => {
        const entries = await Auth.list(c.req.valid("param").providerID)
        return c.json(
          entries.map((entry) => ({
            key: entry.key,
            type: entry.info.type,
            label:
              entry.info.type === "oauth" && entry.info.accountId
                ? entry.info.accountId
                : entry.info.type === "api"
                  ? "API key"
                  : entry.key,
          })),
        )
      },
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          authKey: z.string().optional().meta({ description: "Target auth key for multi-account" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, authKey } = c.req.valid("json")
        const result = await ProviderAuth.authorize({
          providerID,
          method,
          authKey,
        })
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
          authKey: z.string().optional().meta({ description: "Target auth key for multi-account" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, code, authKey } = c.req.valid("json")
        await ProviderAuth.callback({
          providerID,
          method,
          code,
          authKey,
        })
        return c.json(true)
      },
    )
    .get(
      "/accounts",
      describeRoute({
        summary: "Get account pool status",
        description: "Get the status of all multi-account pools for providers with multiple API keys.",
        operationId: "provider.accounts",
        responses: {
          200: {
            description: "Account pool status by provider",
            content: {
              "application/json": {
                schema: resolver(
                  z.record(
                    z.string(),
                    z.object({
                      providerID: z.string(),
                      activeIndex: z.number(),
                      accounts: z.array(
                        z.object({
                          index: z.number(),
                          label: z.string(),
                          status: z.enum(["active", "cooldown", "disabled"]),
                          requestCount: z.number(),
                          tokenCount: z.number(),
                          switchCount: z.number(),
                          cooldownUntil: z.number().optional(),
                        }),
                      ),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Provider.accountsStatus())
      },
    )
    .post(
      "/:providerID/accounts/add",
      describeRoute({
        summary: "Add account",
        description: "Add an API key account to a provider via Auth storage.",
        operationId: "provider.accounts.add",
        responses: {
          200: {
            description: "Account added",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    key: z.string(),
                    label: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: z.string().meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          apiKey: z.string().meta({ description: "API key" }),
          label: z.string().optional().meta({ description: "Account label" }),
        }),
      ),
      async (c) => {
        const { providerID } = c.req.valid("param")
        const { apiKey, label } = c.req.valid("json")
        const authKey = await Auth.nextKey(providerID)
        await ProviderAuth.api({ providerID, key: apiKey, authKey })
        return c.json({ key: authKey, label: label ?? `Account #${authKey.split(":")[1] ?? "1"}` })
      },
    )
    .post(
      "/:providerID/accounts/remove",
      describeRoute({
        summary: "Remove account",
        description: "Remove an auth entry from a provider by its auth key.",
        operationId: "provider.accounts.remove",
        responses: {
          200: {
            description: "Account removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          authKey: z.string().meta({ description: "Auth key to remove (e.g. anthropic:1)" }),
        }),
      ),
      async (c) => {
        const { authKey } = c.req.valid("json")
        await Auth.remove(authKey)
        return c.json(true)
      },
    ),
)
