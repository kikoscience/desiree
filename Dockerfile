FROM node:18-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
# Set permissions if needed, otherwise rely on host volume mount for uploads
USER node
EXPOSE 3000
CMD ["npm", "start"]
