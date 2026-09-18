# Udviklingsimage. Formålet er at køre appen mod den samme Postgres som
# produktionen, ikke at være et hærdet produktionsimage.
FROM node:22-slim

WORKDIR /app

# Afhængigheder i et selvstændigt lag, så det genbruges når kun kilden ændrer sig.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

# Der bygges bevidst ikke med tsc. `npm run build` udsender kun .ts-filer til
# dist/, så src/public/ (html, css, js) og db/schema.sql ville mangle i
# outputtet. tsx kører kilden som den er, og det er rigeligt her.
CMD ["npm", "start"]

# node:22-slim har hverken curl eller wget; Node har fetch indbygget.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
