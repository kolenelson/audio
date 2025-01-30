FROM node:18-bullseye

# Install system dependencies
RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    make \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN python3 -m pip install --upgrade pip && \
    python3 -m pip install invoke

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with specific flags for production
ENV NODE_ENV=production
RUN npm ci --only=production

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
