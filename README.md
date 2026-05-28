# Portfolio Watch

A small shareable web app for checking portfolio drawdown, P/L, price history, and related news.

## Features

- Enter holdings directly in the browser.
- Supports A-share symbols such as `300857` and US symbols such as `AAPL`.
- Calculates one-year max drawdown from daily close prices.
- Shows latest related news.
- Saves holdings in the visitor's browser.
- Generates a share link that includes the holdings data in the URL.

## Run Locally

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## Deploy To Render

1. Create a GitHub repository and upload this project.
2. Go to Render and create a new Web Service.
3. Connect the GitHub repository.
4. Render should read `render.yaml` automatically. If entering settings manually, use:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/healthz`
5. Deploy.

After deployment, Render will give you a public URL. Share that URL, or use the app's share button to create a link containing a specific portfolio.

## Privacy Note

The share link stores portfolio symbols, share counts, and cost basis in the URL. Anyone with that link can see those holdings.

