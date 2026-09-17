'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('events', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the event'
      },
      title: {
        type: Sequelize.STRING(500),
        allowNull: false,
        comment: 'Event title'
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Brief description of the event'
      },
      status: {
        type: Sequelize.ENUM('active', 'monitoring', 'resolved'),
        allowNull: false,
        defaultValue: 'active',
        comment: 'Current monitoring status'
      },
      event_date: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Date/time associated with the event'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('events');
  }
};