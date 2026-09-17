'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('contradictions', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the contradiction'
      },
      claim_id_1: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'claims', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'First claim in the contradiction pair'
      },
      claim_id_2: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'claims', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'Second claim in the contradiction pair'
      },
      contradiction_type: {
        type: Sequelize.ENUM('direct', 'partial', 'temporal'),
        allowNull: false,
        defaultValue: 'direct',
        comment: 'Classification of the contradiction'
      },
      status: {
        type: Sequelize.ENUM('unresolved', 'resolved', 'under_review'),
        allowNull: false,
        defaultValue: 'unresolved',
        comment: 'Resolution status'
      },
      reason: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Explanation of the contradiction'
      },
      detected_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
        comment: 'When the contradiction was detected'
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

    await queryInterface.addIndex('contradictions', ['claim_id_1'], {
      name: 'idx_contradictions_claim_id_1'
    });
    await queryInterface.addIndex('contradictions', ['claim_id_2'], {
      name: 'idx_contradictions_claim_id_2'
    });
    await queryInterface.addIndex('contradictions', ['claim_id_1', 'claim_id_2'], {
      name: 'idx_contradictions_unique',
      unique: true
    });
    await queryInterface.addIndex('contradictions', ['status'], {
      name: 'idx_contradictions_status'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('contradictions');
  }
};