FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY bin ./bin
COPY src ./src

RUN npm install --omit=dev && npm install --global .

ENV NODE_ENV=production
EXPOSE 8080

USER node
CMD ["runpublic-edge"]
