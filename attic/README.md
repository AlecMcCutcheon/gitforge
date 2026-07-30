# Attic

Historical pieces kept out of the active GitForge workflow.

## `local-api-server/`

Former Express bridge on `:8787` (`npm run dev:server`). Tip-browse and Hub
owner tools now run entirely against the Freenet node WebSocket / website
contract.

**Primary test surface:**

```sh
npm run publish:website
```

Then open the published contract URL on your local node (`:7509`).
