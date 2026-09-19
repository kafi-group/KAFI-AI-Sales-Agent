FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
ENV PORT=3003
EXPOSE 3003
CMD ["npm", "start"]
