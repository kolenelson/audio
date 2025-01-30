# Use Node.js 18 as the base image
FROM node:18-bullseye

# Install system dependencies required for mediasoup
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY . .

# Build TypeScript
RUN npm run build

# Expose the application port
EXPOSE 3000

# Expose mediasoup RTC ports
EXPOSE 10000-10100/udp

# Start the application
CMD ["npm", "start"]
